const moment = require("moment");
const momenttz = require("moment-timezone");
const geodist = require('geodist')
const point_line_distance = require('point-line-distance');

const shallow_clone = function(obj) { return Object.assign({}, obj); }

// Load API keys.
const fs = require("fs");
var api_keys = { };
fs.readFileSync('api_keys.txt').toString("ascii").split(/[\r\n]+/g).forEach(function(line) {
  line = line.split(/=/);
  if (line[0])
    api_keys[line[0]] = line[1];
});

// Generic helper to call WMATA and Geocod.io APIs.

var web_request_mem_cache = { };
var web_request_disk_cache = require('async-disk-cache');
web_request_disk_cache = new web_request_disk_cache('trip-planner');
function web_request(host, path, qs, headers, postbody, cache) {
  return new Promise(function(resolve, reject) {
    const https = require('https');
    const querystring = require('querystring');
    path += "?" + querystring.stringify(qs);

    var cache_key = host + ":" + path;
    if (cache_key in web_request_mem_cache) {
      resolve(web_request_mem_cache[cache_key]);
      return;
    }

    web_request_disk_cache.get(cache_key).then(function(cacheEntry) {
      if (cacheEntry.isCached) {
        var body = JSON.parse(cacheEntry.value);
        web_request_mem_cache[cache_key] = body;
        resolve(body);
        return;
      }

      var method = (!postbody ? "GET" : "POST");

      console.log(">", method, path);
      var req = https.request({
        method: method,
        host: host,
        path: path,
        headers: headers,
      }, (res) => {
        var body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          var body_parsed = JSON.parse(body);

          // Error message detection across the particular APIs we're calling.
          if ('statusCode' in body_parsed && body_parsed.statusCode != 200) {
            reject(body_parsed.message);
            return;
          }
          if (body_parsed.Message) {
            reject(body_parsed.Message);
            return;
          }

          if (cache) {
            web_request_mem_cache[cache_key] = body_parsed;
            web_request_disk_cache.set(cache_key, body); // ignore promise completion
          }
          resolve(body_parsed);
        });
      }).on('error', (e) => {
        reject(e);
      });

      if (postbody)
        req.write(postbody);

      req.end();
    });
  })
}

function wmata_api(path, qs, cache) {
  return web_request('api.wmata.com', path, qs, { api_key: api_keys['wmata'] }, null, cache)
}

async function geocode(addresses) {
  var resp = await web_request("api.geocod.io", "/v1.2/geocode", { api_key: api_keys['geocodio'] },
    { "Content-Type": "application/json" },
    JSON.stringify(addresses));
  return resp.results.map((item) => item.response);
}

// Global route data.
all_station_stops = null;
all_station_stops_by_id = null;
all_routegroups = null;
all_station_stops_by_routegroup_pairs = null;
route_handlers = { };
async function load_initial_data() {
  // Load stops and routes.
  all_station_stops = [];
  all_routegroups = { };
  await load_wmata_metro_rail();
  await load_wmata_metro_bus();

  // Index stops by id.
  all_station_stops_by_id = { };
  all_station_stops.forEach(function(stop) {
    all_station_stops_by_id[stop.id] = stop;
  });

  // Index stops by the pairs of routes they have, for transfers.
  all_station_stops_by_routegroup_pairs = {};
  all_station_stops.forEach(function(stop) {
    Object.keys(stop.routegroups).forEach(function(r1) {
      Object.keys(stop.routegroups).forEach(function(r2) {
        if (r1 == r2) return;
        var pair = r1 + "__" + r2;
        if (!(pair in all_station_stops_by_routegroup_pairs))
          all_station_stops_by_routegroup_pairs[pair] = [];
        all_station_stops_by_routegroup_pairs[pair].push(stop);
      });
    });
  });
}

function getRouteFromId(routeid) {
  var rp = routeid.split(/:/);
  return route_handlers[rp[0]].getRoute(routeid);
}

function getRouteStops(route) {
  var rp = route.id.split(/:/);
  return route_handlers[rp[0]].getStops(route);
}

function getRouteEstimatedTripTime(route, start_stop, end_stop) {
  var rp = route.id.split(/:/);
  return route_handlers[rp[0]].getEstimatedTripTime(route, start_stop, end_stop);
}

function getRoutePredictions(route, stop, end_stop, cached_predictions) {
  var rp = route.id.split(/:/);
  return route_handlers[rp[0]].getPredictions(route, stop, end_stop, cached_predictions);
}

async function load_wmata_metro_rail() {
  // Load WMATA Metro Rail data.

  // Get line, station, and entrances. The entrances are
  // our 'stops'. Lines become both "routegroups" and a
  // single actual route within the routegroup.
  const wmata_rail_lines = await wmata_api('/Rail.svc/json/jLines', {}, true);
  const wmata_rail_entrances = await wmata_api('/Rail.svc/json/jStationEntrances', {}, true);
  const wmata_rail_stations = await wmata_api('/Rail.svc/json/jStations', {}, true);
  var line_names = { };
  wmata_rail_lines.Lines.forEach(function(line_data) {
    line_names[line_data.LineCode] = line_data.DisplayName + " Line";
  })

  // Add a 'stop' for each entrace.
  wmata_rail_entrances.Entrances.forEach(function(entrance) {
    // Go from the entrance to the station to get the station name.
    // An entrance might be tied to two stations if it's a transfer
    // station (i.e. Gallery Place is actually two co-located stations),
    // but those stations have the same name so it doesn't matter which
    // we use.
    var station_name = null;
    wmata_rail_stations.Stations.forEach(function(station) {
      if (station.Code == entrance.StationCode1 || station.Code == entrance.StationCode2)
        station_name = station.Name;
    });

    // What lines are at this station? Look at the staion at this entrace, which
    // has a list of lines. Those turn into routegroups.
    var lines = { };
    wmata_rail_stations.Stations.forEach(function(station) {
      if (station.Code != entrance.StationCode1 && station.Code != entrance.StationCode2)
        return;

      [station.LineCode1, station.LineCode2, station.LineCode3, station.LineCode4].forEach(function(line) {
        if (line == null) return;
        lines[add_routegroup(line)] = true;
      });
    });

    // Shorten station name: Take part up to first dash.
    station_name = station_name.split(/-/)[0];

    all_station_stops.push({
      id: "wmata_rail:" + entrance.ID,
      group_id: "wmata_rail:" + station_name,
      modality: "wmata_rail",
      name: station_name, // entrance.Name,
      coord: [entrance.Lat, entrance.Lon],
      time_to_enter_and_exit: 2,
      routegroups: lines,
      transfer_time: 1, // minute
      avg_speed: 15, // MPH
      raw: entrance
    });
  });

 function add_routegroup(line) {
    id = "wmata_rail:" + line;
    if (id in all_routegroups)
      return id;

    all_routegroups[id] = {
      id: id,
      getRoutes: async function() {
        // Return one direction for each line. We'll filter when we do
        // predictions to ensure we go the right way.
        return [await get_route_from_id("wmata_rail:" + line)];
      },
    };

    return id;
  }

  async function get_route_from_id(route_id) {
    route_id = route_id.split(/:/);
    var line = route_id[1];
    return {
      id: "wmata_rail:" + line,
      short_name: line_names[line],
      long_name: line_names[line] + " train",
      modality: 'wmata_rail',
      line: line,
    }
  }

  route_handlers['wmata_rail'] = {
    getRoute: get_route_from_id,
    getStops: async function(route) { return null }, // assume all stations are on all runs
    getEstimatedTripTime: async function(route, start_stop, end_stop) {
      if (start_stop.raw.StationCode1 == end_stop.raw.StationCode1)
        return 1; // minimum of one minute transfer
      if (start_stop.raw.StationCode1 == end_stop.raw.StationCode2)
        return 1; // minimum of one minute transfer
      if (start_stop.raw.StationCode2 == end_stop.raw.StationCode1)
        return 1; // minimum of one minute transfer
      if (start_stop.raw.StationCode2 && start_stop.raw.StationCode2 == end_stop.raw.StationCode2)
        return 1; // minimum of one minute transfer
      var info = await wmata_api('/Rail.svc/json/jSrcStationToDstStationInfo', { FromStationCode: start_stop.raw.StationCode1, ToStationCode: end_stop.raw.StationCode1 }, true);
      if (!info.StationToStationInfos) return null;
      return info.StationToStationInfos[0].RailTime;
    },
    getPredictions: async function(route, stop, end_stop, cached_predictions) {
      // Get real time predictions at the stop.
      var station_codes = stop.raw.StationCode1 + "," + (stop.raw.StationCode2||"");
      var cache_key = "rail:" + station_codes;
      if (!(cache_key in cached_predictions))
        cached_predictions[cache_key] = await wmata_api('/StationPrediction.svc/json/GetPrediction/' + station_codes);
      if (!cached_predictions[cache_key].Trains) return [];
      var preds = [];
      for (var i = 0; i < cached_predictions[cache_key].Trains.length; i++) {
        // Filter out predictions to have just the ones for the line
        // and that have an intermediate stop at end_stop.
        var train = cached_predictions[cache_key].Trains[i];
        if (train.Line != route.line) continue;
        var path1 = await wmata_api('/Rail.svc/json/jPath', { FromStationCode: stop.raw.StationCode1, ToStationCode: train.DestinationCode }, true);
        var path2 = await wmata_api('/Rail.svc/json/jPath', { FromStationCode: stop.raw.StationCode2, ToStationCode: train.DestinationCode }, true);
        var path = (path1.Path || []).concat( (path2.Path || []) );
        path.forEach(function(station) {
          if (station.StationCode != end_stop.raw.StationCode1
            && station.StationCode != end_stop.raw.StationCode2)
            return;
          // This train makes a stop at the end stop.
          var min = parseInt(train.Min);
          if (min)
            preds.push({
              time: min,
              short_name: line_names[train.Line],
              long_name: line_names[train.Line] + " train toward " + train.DestinationName,
            });
        })
      }
      return preds;
    },    
  }
}

async function load_wmata_metro_bus() {
  // Load WMATA Metro Bus data.
  var wmata_bus_stops = await wmata_api('/Bus.svc/json/jStops', {}, true);
  wmata_bus_stops.Stops.forEach(function(stop) {
    // What routes (for us, routegroups because we treat each direction
    // of a route as a "route") is this stop on?
    var routegroups = { };
    stop.Routes.map(function(route) {
      routegroups[add_routegroup(route)] = true;
    });

    // Clean up stop names for speech.
    var stop_name = stop.Name;
    var abbrevs = {
      "+": "and",
      "ALY": "alley",
      "APT": "apartment",
      "APTS": "apartments",
      "AVE": "avenue",
      "BETW": "between",
      "BLVD": "boulevard",
      "CT": "court",
      "DR": "drive",
      "NE": "northeast",
      "NW": "northwest",
      "PKWY": "parkway",
      "PL": "place",
      "RD": "road",
      "RT": "route",
      "SE": "southeast",
      "ST": "street",
      "ST.": "street",
      "STA": "station",
      "STA.": "station",
      "SW": "southwest",
    };
    stop_name = stop_name.split(/\s+/);
    for (var i = 0; i < stop_name.length; i++)
      if (stop_name[i] in abbrevs)
        stop_name[i] = abbrevs[stop_name[i]];
    stop_name = stop_name.join(" ");

    // Add station.
    all_station_stops.push({
      id: "wmata_bus:" + stop.StopID,
      group_id: "wmata_bus:" + stop.StopID,
      modality: "wmata_bus",
      name: stop_name,
      coord: [stop.Lat, stop.Lon],
      time_to_enter_and_exit: 0,
      //transfer_time: 10, // minutes, estimating time to next bus arrival
      can_transfer: false,
      avg_speed: 8, // MPH
      raw: stop,
      routegroups: routegroups,
    });
  });

  function add_routegroup(route) {
    var id = "wmata_bus:" + route;
    if (id in all_routegroups)
      return id;

    all_routegroups[id] = {
      id: "wmata_bus:" + route,
      getRoutes: async function() {
        var routedata = await wmata_api('/Bus.svc/json/jRouteDetails', { RouteID: route }, true);
        var directions = [];
        if (routedata.Direction0)
          directions.push(await get_route_from_id("wmata_bus:" + routedata.RouteID + ":" + "0"))
        if (routedata.Direction1)
          directions.push(await get_route_from_id("wmata_bus:" + routedata.RouteID + ":" + "1"))
        return directions;
      },
    };

    return id;
  }

  async function get_route_from_id(route_id) {
    route_id = route_id.split(/:/g);
    var routeid = route_id[1];
    var direction_num = route_id[2];
    var routedata = await wmata_api('/Bus.svc/json/jRouteDetails', { RouteID: routeid }, true);
    var direction = routedata['Direction' + direction_num];
    return {
      id: "wmata_bus:" + routeid + ":" + direction_num,
      short_name: routedata.RouteID,
      long_name: routedata.RouteID + " bus going " + direction.DirectionText + " toward " + direction.TripHeadsign,
      modality: 'wmata_bus',
      routeid: routedata.RouteID,
      direction_num: direction_num,
    };
  }

  route_handlers['wmata_bus'] = {
    getRoute: get_route_from_id,
    getStops: async function(route) {
      var routedata = await wmata_api('/Bus.svc/json/jRouteDetails', { RouteID: route.routeid }, true);
      var direction = routedata["Direction" + route.direction_num];
      return direction.Stops.map(function(stop) { return "wmata_bus:" + stop.StopID })
    },
    getEstimatedTripTime: async function(route, start_stop, end_stop) {
      // Compute the total transit time. Use schedule data for today to find the next trip.
      var now = moment();
      var route_schedule = await wmata_api('/Bus.svc/json/jRouteSchedule', {
        RouteID: route.routeid,
        Date: moment().format("YYYY-MM-DD"),
      }, true);
      var runs = route_schedule["Direction" + route.direction_num];
      if (!runs || runs.length == 0)
        return null; // no schedule for today?
      var avg_duration = 0;
      for (let j = 0; j < runs.length; j++) {
        // Find the start and end stops on this run.
        let run = runs[j].StopTimes;
        let start_stop_index = null;
        let end_stop_index = null;
        for (let i = 0; i < run.length; i++) {
          if (run[i].StopID == start_stop.raw.StopID)
            start_stop_index = i;
          if (run[i].StopID == end_stop.raw.StopID)
            end_stop_index = i;
        }
        if (start_stop_index === null || end_stop_index == null || end_stop_index <= start_stop_index)
          continue; // stops not on this run, or weirdly the end is before the start

        // TODO: How are LOOP routes handled where the end might be before the start?

        var start_time = moment.tz(run[start_stop_index].Time, "America/New_York");
        var end_time = moment.tz(run[end_stop_index].Time, "America/New_York");
        var d = end_time.diff(start_time, "minutes");
        avg_duration += d;
        if (start_time.diff(now) > 0)
          return d;
      }

      // Found no future scheduled data, so use average.
      return d / runs.length;
    },
    getPredictions: async function(route, stop, end_stop, cached_predictions) {
      if (!(stop.raw.StopID in cached_predictions))
        cached_predictions[stop.raw.StopID] = await wmata_api('/NextBusService.svc/json/jPredictions', { StopID: stop.raw.StopID });
      var preds = [];
      (cached_predictions[stop.raw.StopID].Predictions || []).forEach(function(prediction_run) {
        if ((prediction_run.RouteID == route.routeid) && (prediction_run.DirectionNum == route.direction_num))
          preds.push({ time: prediction_run.Minutes });
      });
      return preds;
    },
  };
};

function simple_distance_squared(p1, p2) {
  // Return the square of the straight line distance between the
  // two points, assuming the points are close so that we don't
  // have to worry about the projection (lat/long) or curvature
  // of the earth.
  return ((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2);
}

function walking_time(p1, p2) {
  // Return the estimated walking time in minutes between two points.
  // An average walking pace is 20 minutes per mile, but a straight
  // line route from p1 to p2 may not be possible, so add a 50%
  // factor to account for street grids, traffic lights, etc.
  return geodist({ lat: p1[0], lon: p1[1] },
                 { lat: p2[0], lon: p2[1] },
                 { unit: "miles", exact: true }) * 30; // 30 minute mile
}

function est_transit_time(s1, s2) {
  // Return the estimated minimum transit time in minutes between two points.
  return geodist({ lat: s1.coord[0], lon: s1.coord[1] },
                 { lat: s2.coord[0], lon: s2.coord[1] },
                 { unit: "miles", exact: true }) / (s1.avg_speed+s2.avg_speed) * 60;
}

async function iterate_stop_pairs_by_distance(start, end, cb) {
  // Sort all of the stops by their distance from the end points.

  function comparer(pt) {
    // Returns a function that can be used as the comparison function
    // to array.sort that orders transit stops from closest to furthest
    // from pt.
    return function(a, b) {
      a = simple_distance_squared(a.coord, pt);
      b = simple_distance_squared(b.coord, pt);
      return a - b;
    };
  }

  var sorted_stops_start = all_station_stops.slice(0).sort(comparer(start)); // clone then sort in place and return it
  var sorted_stops_end = all_station_stops.slice(0).sort(comparer(end)); // clone then sort in place and return it

  // Replace the elements in sorted_stops_start with pairs of
  // [stop, 0].
  sorted_stops_start = sorted_stops_start.map(function(item) {
    return [item, 0];
  })

  // Start iterating in order of stops closest to the start.
  var counter = 0;
  var max_search = 20000;
  var next = sorted_stops_start.shift();
  while (counter < max_search) {
    counter++;
    var start_stop = next[0];
    var end_stop = sorted_stops_end[next[1]++];

    function total_distance(start_stop, end_stop) {
      return (
          simple_distance_squared(start, start_stop.coord)
          + simple_distance_squared(end, end_stop.coord)
        );
    }

    // If the total walking time is more than 45 minutes, stop iterations,
    // those are useless directions.
    if (walking_time(start, start_stop.coord) + walking_time(end, end_stop.coord) > 45)
      return;

    // Take this pair. Call the callback with this pair.
    // If the callback returns true, stop iterating.
    if (start_stop.group_id != end_stop.group_id) {
      if (await cb(start_stop, end_stop))
        return;
    }

    // If there are no more end stops for this start stop, cycle to
    // the next start stop.
    if (next[1] == sorted_stops_end.length) {
      if (sorted_stops_start.length == 0)
        break; // all done
      next = sorted_stops_start.shift();
      continue;
    }

    // Before iterating, see if the next end for this start
    // has a larger total distance than the next start to its next end.
    if (sorted_stops_start.length > 0) {
      for (let i = 0; i < sorted_stops_start.length; i++) {
        if (sorted_stops_start[i][1] >= next[1]) continue;

        var d0 = total_distance(next[0], sorted_stops_end[next[1]]);
        var d1 = total_distance(sorted_stops_start[i][0], sorted_stops_end[sorted_stops_start[i][1]]);
        if (d0 > d1) {
          // Flip.
          //console.log("<", next[0].StopID, next[0].Name, "|", sorted_stops_end[next[1]].Name, "|", d0);
          //console.log(">", sorted_stops_start[i][0].StopID, sorted_stops_start[i][0].Name, "|", sorted_stops_end[sorted_stops_start[i][1]].Name, "|", d1);
          let new_next = sorted_stops_start[i];
          sorted_stops_start[i] = next;
          next = new_next;
        }
        break;
      }
    }
  }
}

async function calculate_routes(start, end) {
  // Compute the fastest route from start to end. Iterate over the
  // pairs of stops nearest to the end points in ascending order
  // over total distance first assuming no transfers, then assuming
  // one transfer.

  var seen_routes = { };
  var trips = [];

  // Compute no-transfer routes.

  function key_intersection(o1, o2) {
      return Object.keys(o1).filter({}.hasOwnProperty.bind(o2));
  }
  await iterate_stop_pairs_by_distance(start, end, async function(start_stop, end_stop) {
    // Are these stops on any of the same routegroups? For each
    // routegroup they have in common, look for an actual route
    // between them.
    var routegroups = key_intersection(start_stop.routegroups, end_stop.routegroups);
    for (var i = 0; i < routegroups.length; i++) {
      var trip = await try_start_stop_routegroup(start, end, start_stop, end_stop, routegroups[i], seen_routes);
      if (trip)
        trips.push(trip);
    }
  });

  // Find the maximum trip time.
  var max_trip_time = 0;
  trips.forEach(function(trip) {
    if (trip.total_time > max_trip_time)
      max_trip_time = trip.total_time;
  })
  if (max_trip_time == 0)
    max_trip_time = walking_time(start, end);

  // Find one-transfer routes that are no slower than the worst
  // time we found so far.
  await iterate_stop_pairs_by_distance(start, end, async function(start_stop, end_stop) {
    if (start_stop.modality != end_stop.modality)
      return;

    if ("can_transfer" in start_stop && !start_stop.can_transfer)
      return;
    if ("can_transfer" in end_stop && !end_stop.can_transfer)
      return;

    // Stop if this pair of stops requires more walking distance that no
    // transfer could be faster than the fastest route we have already.
    if (
        walking_time(start, start_stop.coord)
      + est_transit_time(start_stop, end_stop)/2
      + (start_stop.transit_time+end_stop.transfer_time)/2 // est. transfer time
      + walking_time(end, end_stop.coord)
      > max_trip_time)
      return true;

    // Get possible transfer stops.
    var transfer_stops = [];
    Object.keys(start_stop.routegroups).forEach(function(r1) {
      Object.keys(end_stop.routegroups).forEach(function(r2) {
        if (r1 == r2) return;
        var pair = r1 + "__" + r2;
        if (pair in all_station_stops_by_routegroup_pairs)
          all_station_stops_by_routegroup_pairs[pair].forEach(function(stop) {
            if (stop.group_id != start_stop.group_id && stop.group_id != end_stop.group_id)
              transfer_stops.push(stop);
          });
      });
    });

    // Look at the stops in order of closeness to the line from the start to
    // the end stop.
    function comparer(a, b) {
      a = point_line_distance(a.coord, start_stop.coord, end_stop.coord);
      b = point_line_distance(b.coord, start_stop.coord, end_stop.coord);
      return a - b;
    }
    transfer_stops.sort(comparer);

    for (var m = 0; m < transfer_stops.length; m++) {
      if (m > 150) break;
      var transfer_stop = transfer_stops[m];

      // Stop if the route would be slower than what we have already.
      if (
          walking_time(start, start_stop.coord)
        + est_transit_time(start_stop, transfer_stop)
        + transfer_stop.transit_time
        + est_transit_time(transfer_stop, end_stop)
        + walking_time(end_stop.coord, end)
            > max_trip_time)
        break;

      // Which routes matched?
      var routegroups1 = key_intersection(start_stop.routegroups, transfer_stop.routegroups);
      var routegroups2 = key_intersection(end_stop.routegroups, transfer_stop.routegroups);
      for (let i = 0; i < routegroups1.length; i++)
        for (let j = 0; j < routegroups2.length; j++)
          if (routegroups1[i] != routegroups2[j]) { // don't do the same route, that's not a transfer
            // Only take this transfer if we haven't used this starting line yet.
            if (all_routegroups[routegroups1[i]].id in seen_routes) continue;

            var trip = await try_start_transfer_stop_route(start_stop, routegroups1[i], transfer_stops[m], end_stop, routegroups2[j]);
            if (trip) {
              //console.log(routegroups1[i] + "*" + transfer_stop.group_id)

              // Stop if the best transfer is too long.
              if (trip.total_time > max_trip_time * 1.2)
                return trips;

              seen_routes[all_routegroups[routegroups1[i]].id] = true;
              trips.push(trip);
            }
          }
    }
  });


  async function try_start_stop_routegroup(start, end, start_stop, end_stop, routegroup, seen_routes, is_transfer) {
    // Although they share a routegroup, which for WMATA Metro Bus is the
    // name of a route, they could be on different directions of the route,
    // or the end stop could precede the start stop. Look at the actual
    // routes now. Return the first matching route.
    var routes = await all_routegroups[routegroup].getRoutes();
    for (var i = 0; i < routes.length; i++) {
      var trip = await try_start_stop_route(start, end, start_stop, end_stop, routes[i], seen_routes, is_transfer);
      if (trip)
        return trip;
    }
  }

  async function try_start_stop_route(start, end, start_stop, end_stop, route, seen_routes, is_transfer) {
    // Check that the stops are on the route and they are in the order
    // the vehicle is going.
    var route_stops = await getRouteStops(route);
    if (route_stops) {
      // Get the index of each stop in the route's path.
      var start_stop_index = null;
      var end_stop_index = null;
      for (let i = 0; i < route_stops.length; i++) {
        if (route_stops[i] == start_stop.id)
          start_stop_index = i;
        if (route_stops[i] == end_stop.id)
          end_stop_index = i;
      }

      // If either stop isn't actually on the route, this route does not apply.
      if (start_stop_index === null || end_stop_index === null)
        return;

      // If the end is before the start, this doesn't apply either.
      if (end_stop_index <= start_stop_index)
        return;
    }

    // Only the first time we encounter a route should be returned since later
    // times will have worst start/end stops.
    if (route.id in seen_routes)
      return;
    seen_routes[route.id] = true;

    var duration = await getRouteEstimatedTripTime(route, start_stop, end_stop);

    // Could not find a run to compute duration?
    if (duration === null)
      return;

    // Skip this trip if walking between the stops isn't much worse
    // than taking transit between them.
    var start_walking_time = walking_time(start, start_stop.coord) + start_stop.time_to_enter_and_exit;
    var end_walking_time = walking_time(end, end_stop.coord) + end_stop.time_to_enter_and_exit;
    if (duration < 5 && !is_transfer)
      return null; // don't bother taking transit for less than 3 minutes, except when transferring
    if (walking_time(start_stop.coord, end_stop.coord) < (start_walking_time + end_walking_time)/2)
      return null;

    // Add this trip.
    return {
      route: route.id,
      start_stop: start_stop.id,
      end_stop: end_stop.id,
      start_walking_time: start_walking_time,
      walking_time: start_walking_time+end_walking_time,
      transit_time: duration,
      total_time: start_walking_time + duration + end_walking_time,
    };
  }

  async function try_start_transfer_stop_route(start_stop, start_route, transfer_stop, end_stop, end_route) {
    var trip1 = await try_start_stop_routegroup(start, transfer_stop.coord, start_stop, transfer_stop, start_route, {}, true);
    var trip2 = await try_start_stop_routegroup(transfer_stop.coord, end, transfer_stop, end_stop, end_route, {}, true);
    //console.log(start_stop.name, "|", start_route, "|", trip1, "|", transfer_stop.name, "|", trip2, "|", end_stop.name, "|", end_route)
    if (trip1 && trip2) {
      return {
        route: trip1.route,
        start_stop: start_stop.id,
        end_stop: end_stop.id,
        transfer_stop: transfer_stop.id,
        transfer_route: trip2.route,
        start_walking_time: trip1.start_walking_time,
        walking_time: trip1.walking_time + trip2.walking_time,
        transit_time: trip1.transit_time + transfer_stop.transfer_time + trip2.transit_time,
        total_time: trip1.total_time + transfer_stop.transfer_time + trip2.total_time,
      };
    }
  }

  return trips;
}

async function refill_trip_metadata(trip) {
  // Expand the route, start_stop, end_stop, transfer_stop, and transfer_route
  // which are IDs into their longer data structures.
  trip.start_stop = all_station_stops_by_id[trip.start_stop];
  trip.end_stop = all_station_stops_by_id[trip.end_stop];
  trip.transfer_stop = all_station_stops_by_id[trip.transfer_stop];
  trip.route = await getRouteFromId(trip.route);
  trip.transfer_route = trip.transfer_route ? await getRouteFromId(trip.transfer_route) : null;
}

async function get_trip_predictions(trips) {
  // TODO: The trip's total_time and transit_time are based on
  // schedule data when the trips were computed. Maybe update
  // them with current schedule data since travel times change
  // depending on when they occur.

  trips = trips.slice(); // clone since we edit metadata

  // For each trip, explode it into copies for each next transit
  // prediction time.
  var cached_predictions = { };
  var trip_runs = [];
  for (var i = 0; i < trips.length; i++) {
    var trip = trips[i];

    // Add back metadata.
    trip = shallow_clone(trip);
    await refill_trip_metadata(trip);

    // Get the transit predictions at the start stop.
    var preds = await getRoutePredictions(trip.route, trip.start_stop, trip.transfer_stop || trip.end_stop, cached_predictions);
    var added_any_runs = false;
    preds.forEach(function(pred) {
      // Skip if the user can't walk there in time. Our walk
      // time estimate is pretty rough, and we don't want to
      // not tell the user about a possible next trip that
      // they can actually make. So factor the walking time
      // down.
      if (pred.time < .75*trip.start_walking_time)
        return;

      // Return this trip.
      added_any_runs = true;
      var tp = shallow_clone(trip);
      tp.route_name_long = pred.long_name || trip.route.long_name;
      tp.route_name_short = pred.short_name || trip.route.short_name;
      tp.arrival = pred.time;
      tp.total_time = pred.time + trip.total_time - trip.start_walking_time;
      trip_runs.push(tp);
    })

    // If no predictions are available, add any entry anyway
    // to let the user know we know there's a route but it
    // might not be available right now.
    if (!added_any_runs) {
      var tp = shallow_clone(trip);
      tp.route_name_long = trip.route.long_name;
      tp.route_name_short = trip.route.short_name;
      trip_runs.push(tp);
    }
  }

  // Sort by the total time to destination + double counting the walking
  // time because walking is worse.
  trip_runs.sort(function(a, b) {
    if ((typeof a.prediction == "undefined") != (typeof b.prediction == "undefined"))
      return (typeof a.prediction == "undefined") ? 1 : -1;
    return (a.total_time - b.total_time) + (a.walking_time - b.walking_time)
  });

  // Return the routes which are now in the best order.
  return trip_runs;
}

exports.get_upcoming_trips = async function(start_address, end_address) {
  // Geocode the addresses.
  var geocode_results = await geocode([start_address, end_address]);
  geocode_results = geocode_results.map(function(item) {
    return {
      name: item.results[0].formatted_address,
      coord: [item.results[0].location.lat, item.results[0].location.lng],
    };
  })
  var start = geocode_results[0];
  var end = geocode_results[1];

  // Calculate routes and return next predictions.
  var trips = await calculate_routes(start.coord, end.coord);
  trips = await get_trip_predictions(trips);
  return {
    start: start,
    end: end,
    routes: trips,
  };
}

exports.compute_routes = async function(start_address, end_address) {
  // Geocode the addresses.
  var geocode_results = await geocode([start_address, end_address]);
  geocode_results = geocode_results.map(function(item) {
    return {
      name: item.results[0].formatted_address,
      coord: [item.results[0].location.lat, item.results[0].location.lng],
    };
  })
  var start = geocode_results[0];
  var end = geocode_results[1];

  // Calculate routes.
  var routes = await calculate_routes(start.coord, end.coord);
  return {
    v: 1,
    start: start,
    end: end,
    routes: routes,
  };
}

async function explain_route(route) {
  if (typeof route.route === "string") {
    route = shallow_clone(route);
    await refill_trip_metadata(route);
  }
  return ("A " + route.route.long_name + " at " + route.start_stop.name
    + " takes you to " + route.end_stop.name
    + (route.transfer_stop ? (" with a transfer to the " + route.transfer_route.long_name
          + " at " + route.transfer_stop.name) : "")
    + " with a total travel time of " + parseInt(route.total_time) + " minutes with about "
    + parseInt(route.walking_time) + " minutes of walking.");
}

exports.explain_route = async function(route) {
  return await explain_route(route);
}

async function merge_similar_routes(routes) {
  // Expand.
  for (var i = 0; i < routes.length; i++) {
    if (typeof routes[i].route === "string") {
      routes[i] = shallow_clone(routes[i]);
      await refill_trip_metadata(routes[i]);
    }
  }

  // Merge.
  var i = 1;
  while (i < routes.length) {
    if ( routes[i-1].start_stop.name == routes[i].start_stop.name
      && (routes[i-1].transfer_stop&&routes[i-1].transfer_stop.name) == (routes[i].transfer_stop&&routes[i].transfer_stop.name)
      && (routes[i-1].transfer_route&&routes[i-1].transfer_route.long_name) == (routes[i].transfer_route&&routes[i].transfer_route.long_name)
      && routes[i-1].total_time == routes[i].total_time
      ) {
      // combine with i-1
      routes[i-1].route.long_name += " or " + routes[i].route.long_name;
      routes[i-1].route.short_name += " or " + routes[i].route.short_name;
      // remove i
      routes.splice(i, 1);
    } else {
      i++;
    }
  }
}

exports.merge_similar_routes = async function(routes) {
  await merge_similar_routes(routes);
}

exports.get_predictions = async function(trip) {
  var routes = await get_trip_predictions(trip.routes);
  return {
    start: trip.start,
    end: trip.end,
    routes: routes,
  };
}

async function do_demo() {
  // Compute the route and get next vehicle predictions.
  var trip = await exports.get_upcoming_trips(process.argv[2], process.argv[3]);

  // List the next vehicle times.
  trip.routes.forEach(function(trip) {
    console.log("At", trip.start_stop.name,
                "a", trip.route_name_long,
                "is arriving in", trip.arrival, "minutes",
                //"(that's", parseInt(trip.time_to_spare), "minutes to spare)",
                "(" + (trip.transfer_stop ? "transfer at " + trip.transfer_stop.name + " to the " + trip.transfer_route.long_name + " and " : "") + "get off at", trip.end_stop.name, ")",
                "with an ETA of", parseInt(trip.total_time), "minutes",
                "(" + parseInt(trip.walking_time), "min. walking)",
                );
  });

  // Show route explanations.
  console.log()
  await merge_similar_routes(trip.routes);
  for (var i = 0; i < trip.routes.length; i++) {
    console.log(await explain_route(trip.routes[i]));
  }  
}

// Hmm, async...
load_initial_data()
  .then(function() {
    if (process.argv[1] && /trip-planner/.test(process.argv[1])) {
      try {
        do_demo();
      } catch (err) {
        console.log(err);
      }
    }
  })
  .catch(function(err) {
    console.log("ERROR: Error loading initial data:", err);
  });
