const moment = require("moment");
const momenttz = require("moment-timezone");
const geodist = require('geodist')

// Load WMATA API key.
const fs = require("fs");
var api_key = fs.readFileSync('wmata_api_key.txt').toString("ascii").replace(/[\r\n]*$/, "");

// Generic helper to call WMATA API.
var web_request_cache = { };
function web_request(host, path, qs, cache) {
  return new Promise(function(resolve, reject) {
    const https = require('https');
    const querystring = require('querystring');
    path += "?" + querystring.stringify(qs);

    if (path in web_request_cache) {
      resolve(web_request_cache[path]);
      return;
    }

    https.get({
      host: host,
      path: path,
      headers: {
        api_key: api_key
      }
    }, (res) => {
      console.log(">", path, res.statusCode);
      var body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        body = JSON.parse(body);
        if (cache)
          web_request_cache[path] = body;
        resolve(body);
      });
    }).on('error', (e) => {
      reject(null);
    });
  })
}

function wmata_api(path, qs, cache) {
  return web_request('api.wmata.com', path, qs, cache)
}

station_stops = null;
async function load_initial_data() {
  station_stops = [];

  // Load WMATA Metro Rail data.
  var wmata_rail_lines = await wmata_api('/Rail.svc/json/jLines', {}, true);
  var wmata_rail_entrances = await wmata_api('/Rail.svc/json/jStationEntrances', {}, true);
  var wmata_rail_stations = await wmata_api('/Rail.svc/json/jStations', {}, true);
  var line_names = { };
  wmata_rail_lines.Lines.forEach(function(line_data) {
    line_names[line_data.LineCode] = line_data.DisplayName + " Line";
  })

  wmata_rail_entrances.Entrances.forEach(function(entrance) {
    // What is the station name?
    // What lines are at this station?
    var station_name = null;
    var lines = [];
    wmata_rail_stations.Stations.forEach(function(station) {
      if (station.Code == entrance.StationCode1 || station.Code == entrance.StationCode2) {
        station_name = station.Name;

        [station.LineCode1, station.LineCode2, station.LineCode3, station.LineCode4].forEach(function(line) {
          if (line == null) return;

          lines.push({
            id: "wmata_rail:" + line,
            getDirectionsMetadata: async function() {
              // Return one direction for each line. We'll filter on
              // predictions to ensure we go the right way.
              return [{
                id: "wmata_rail:" + line,
                name: line_names[line],
                stops: null, // assume all stations are on all runs
                getEstimatedTripTime: async function(start_stop, end_stop) {
                  var info = await wmata_api('/Rail.svc/json/jSrcStationToDstStationInfo', { FromStationCode: start_stop.raw.StationCode1, ToStationCode: end_stop.raw.StationCode1 }, true);
                  return info.StationToStationInfos[0].RailTime;
                },
                get_predictions: async function(stop, end_stop, cached_predictions) {
                  // Get real time predictions at the stop.
                  var station_codes = stop.raw.StationCode1 + "," + (stop.raw.StationCode2||"");
                  var cache_key = "rail:" + station_codes;
                  if (!(cache_key in cached_predictions))
                    cached_predictions[cache_key] = await wmata_api('/StationPrediction.svc/json/GetPrediction/' + station_codes);
                  var preds = [];
                  for (var i = 0; i < cached_predictions[cache_key].Trains.length; i++) {
                    // Filter out predictions to have just the ones for the line
                    // and that have an intermediate stop at end_stop.
                    var train = cached_predictions[cache_key].Trains[i];
                    if (train.Line != line) continue;
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
                          name: line_names[train.Line] + " train toward " + train.DestinationName,
                        });
                    })
                  }
                  return preds;
                },
              }];
            },
          });
        });
      }
    })

    station_stops.push({
      id: "wmata_rail:" + entrance.ID,
      type: "wmata_rail",
      name: station_name, // entrance.Name,
      coord: [entrance.Lat, entrance.Lon],
      time_to_enter_and_exit: 2,
      routes: lines,
      raw: entrance
    });
  });

  // Load WMATA Metro Bus data.
  var wmata_bus_stops = await wmata_api('/Bus.svc/json/jStops', {}, true);
  wmata_bus_stops.Stops.forEach(function(stop) {
    station_stops.push({
      id: "wmata_bus:" + stop.StopID,
      type: "wmata_bus",
      name: stop.Name,
      coord: [stop.Lat, stop.Lon],
      routes: stop.Routes.map(function(route) {
        return {
          id: "wmata_bus:" + route,
          getDirectionsMetadata: async function() {
            var routedata = await wmata_api('/Bus.svc/json/jRouteDetails', { RouteID: route }, true);
            var directions = [];
            function make_direction(direction_num, direction) {
              if (direction == null) return; // a route can have either of its directions be null
              directions.push({
                id: "wmata_bus:" + routedata.RouteID + ":" + direction_num,
                name: routedata.RouteID + " bus going " + direction.DirectionText + " toward " + direction.TripHeadsign,
                stops: direction.Stops.map(function(stop) { return "wmata_bus:" + stop.StopID }),
                getEstimatedTripTime: async function(start_stop, end_stop) {
                  // Compute the total transit time. Use schedule data for today to find the next trip.
                  var now = moment();
                  var route_schedule = await wmata_api('/Bus.svc/json/jRouteSchedule', { RouteID: route }, true);
                  var runs = route_schedule["Direction" + direction_num];
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
                get_predictions: async function(stop, end_stop, cached_predictions) {
                  if (!(stop.raw.StopID in cached_predictions))
                    cached_predictions[stop.raw.StopID] = await wmata_api('/NextBusService.svc/json/jPredictions', { StopID: stop.raw.StopID });
                  var preds = [];
                  (cached_predictions[stop.raw.StopID].Predictions || []).forEach(function(prediction_run) {
                    if ((prediction_run.RouteID == route) && (prediction_run.DirectionNum == direction_num))
                      preds.push({ time: prediction_run.Minutes });
                  });
                  return preds;
                },
              });
            }
            make_direction("0", routedata.Direction0);
            make_direction("1", routedata.Direction1);
            return directions;
          },
        };
      }),
      time_to_enter_and_exit: 0,
      raw: stop
    });
  });
};

function simple_distance_squared(p1, p2) {
  // Return the square of the straight line distance between the
  // two points, assuming the points are close so that we don't
  // have to worry about the projection (lat/long) or curvature
  // of the earth.
  return ((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2);
}

function walking_time(p1, p2) {
  // Return the estimated walking time in minutes between two points
  // at 30 minutes per mile, since an average walking seep is 20 minutes
  // per mile but this is a straight line distance so assume the
  // best route is 50% longer.
  return geodist({ lat: p1[0], lon: p1[1] },
                 { lat: p2[0], lon: p2[1] },
                 { unit: "miles", exact: true }) * 30;
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

  var sorted_stops_start = station_stops.slice(0).sort(comparer(start)); // clone then sort in place and return it
  var sorted_stops_end = station_stops.slice(0).sort(comparer(end)); // clone then sort in place and return it

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

    // If the total walking time is more than 40 minutes, stop iterations,
    // those are useless directions.
    if (walking_time(start, start_stop.coord) + walking_time(end, end_stop.coord) > 40)
      return;

    // Take this pair. Call the callback with this pair.
    // If the callback returns true, stop iterating.
    var dist = total_distance(start_stop, end_stop);
    if (await cb(start_stop, end_stop))
      return;

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

async function compute_routes(start, end) {
  // Compute the fastest route from start to end. Iterate over the
  // pairs of stops nearest to the end points in ascending order
  // over total distance first assuming no transfers, then assuming
  // one transfer. Only try each route once --- the first pair on
  // that route will be the one with the smallest distance to
  // the start and end points.

  var seen_routes = { };
  var trips = [];

  // Compute no-transfer routes.

  await iterate_stop_pairs_by_distance(start, end, async function(start_stop, end_stop) {
    // Are these stops on any of the same routes?
    for (let i = 0; i < start_stop.routes.length; i++)
      for (let j = 0; j < end_stop.routes.length; j++)
        if (start_stop.routes[i].id == end_stop.routes[j].id)
          await try_start_stop_route(start_stop, end_stop, start_stop.routes[i], trips);
  });

  // Find the maximum trip time.
  var max_trip_time = 0;
  trips.forEach(function(trip) {
    if (trip.total_time > max_trip_time)
      max_trip_time = trip.total_time;
  })

  // Find one-transfer routes.
  await iterate_stop_pairs_by_distance(start, end, async function(start_stop, end_stop) {
    if (end_stop.type != "wmata_rail") return true; // only transfer for rail
    var sorted_transfer_stops = station_stops.filter(function(stop) { return stop.type == "wmata_rail"; });
    function comparer(a, b) {
      a = simple_distance_squared(a.coord, start_stop.coord) + simple_distance_squared(a.coord, end_stop.coord);
      b = simple_distance_squared(b.coord, start_stop.coord) + simple_distance_squared(b.coord, end_stop.coord);
      return a - b;
    }
    sorted_transfer_stops = sorted_transfer_stops.slice(0).sort(comparer); // clone then sort in place and return it
    for (var m = 0; m < sorted_transfer_stops.length; m++) {
      // Does any third stop occur on routes that connect both
      // the start and end?
      if (m > 50) break;
      for (let i = 0; i < start_stop.routes.length; i++)
        for (let j = 0; j < sorted_transfer_stops[m].routes.length; j++)
          if (start_stop.routes[i].id == sorted_transfer_stops[m].routes[j].id)
            for (let k = 0; k < end_stop.routes.length; k++)
              for (let l = 0; l < sorted_transfer_stops[m].routes.length; l++)
                if (end_stop.routes[k].id == sorted_transfer_stops[m].routes[l].id) {
                  var trip = await try_start_transfer_stop_route(start_stop, start_stop.routes[i], sorted_transfer_stops[m], end_stop, end_stop.routes[k]);
                  if (trip) {
                    if (trip.total_time > max_trip_time)
                      return true; // this is too long, stop
                    trips.push(trip);
                  }
                }
    }
  });


  async function try_start_stop_route(start_stop, end_stop, route, trips) {
    // Although they are on the same routes, they could be
    // on different directions of the route, or the end stop
    // could precede the start stop (except on a LOOP-directed
    // route, the order does not matter).
    var found = false;
    var directions = await route.getDirectionsMetadata();
    for (var i = 0; i < directions.length; i++)
      if (await try_start_stop_route_direction(start_stop, end_stop, directions[i], trips))
        found = true;
    return found;
  }

  async function try_start_stop_route_direction(start_stop, end_stop, direction, trips) {
    // Check that the stops are on the route and they are in the order
    // the vehicle is going.
    if (direction.stops) {
      // Get the index of each stop in the route's path.
      var start_stop_index = null;
      var end_stop_index = null;
      for (let i = 0; i < direction.stops.length; i++) {
        if (direction.stops[i] == start_stop.id)
          start_stop_index = i;
        if (direction.stops[i] == end_stop.id)
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
    if (direction.id in seen_routes)
      return;
    seen_routes[direction.id] = true;

    var duration = await direction.getEstimatedTripTime(start_stop, end_stop);

    // Could not find a run to compute duration?
    if (duration === null)
      return;

    // Add this trip.
    var start_walking_time = walking_time(start, start_stop.coord) + start_stop.time_to_enter_and_exit;
    var end_walking_time = walking_time(end, end_stop.coord) + end_stop.time_to_enter_and_exit;
    trips.push({
      route: direction,
      start_stop: start_stop,
      end_stop: end_stop,
      start_walking_time: start_walking_time,
      end_walking_time: end_walking_time,
      transit_time: duration,
      total_time: start_walking_time + duration + end_walking_time,
    });

    return true;
  }

  async function try_start_transfer_stop_route(start_stop, start_route, transfer_stop, end_stop, end_route) {
    var trips1 = [];
    await try_start_stop_route(start_stop, transfer_stop, start_route, trips1);

    var trips2 = [];
    await try_start_stop_route(transfer_stop, end_stop, end_route, trips2);

    if (trips1.length > 0 && trips2.length > 0) {
      return {
        route: trips1[0].route,
        start_stop: start_stop,
        end_stop: end_stop,
        transfer_stop: transfer_stop,
        start_walking_time: trips1[0].start_walking_time,
        end_walking_time: trips2[0].end_walking_time,
        transit_time: trips1[0].transit_time+trips2[0].transit_time,
        total_time: trips1[0].total_time + trips2[0].total_time,
      };
    }
  }

  return trips;
}

async function get_trip_predictions(trips) {
  // For each trip, explode it into copies for each next transit
  // prediction time.
  var cached_predictions = { };
  var trip_runs = [];
  for (var i = 0; i < trips.length; i++) {
    // Get the next bus at the start.
    var trip = trips[i];
    var preds = await trip.route.get_predictions(trip.start_stop, trip.transfer_stop || trip.end_stop, cached_predictions);
    var added_any_runs = false;
    preds.forEach(function(pred) {
      // Skip if the user can't walk there in time. Add an extra
      // buffer minute since the user has to listen to our response
      // and leave the house.
      if (pred.time < trip.start_walking_time + 1)
        return;

      // Return this trip.
      added_any_runs = true;
      trip_runs.push({
        route_name: pred.name || trip.route.name,
        stop: trip.start_stop,
        transfer_stop: trip.transfer_stop,
        end_stop: trip.end_stop,
        prediction: pred.time,
        time_to_spare: pred.time - trip.start_walking_time,
        total_time: pred.time + trip.transit_time + trip.end_walking_time,
        total_walking_time: trip.start_walking_time + trip.end_walking_time,
      });
    })

    // If no predictions are available, add any entry anyway
    // to let the user know we know there's a route but it
    // might not be available right now.
    if (!added_any_runs) {
      trip_runs.push({
        route_name: trip.route.name,
        stop: trip.start_stop,
        transfer_stop: trip.transfer_stop,
        end_stop: trip.end_stop,
        total_time: trip.start_walking_time + trip.transit_time + trip.end_walking_time,
        total_walking_time: trip.start_walking_time + trip.end_walking_time,
      });
    }
  }

  // Sort by the total time to destination.
  trip_runs.sort(function(a, b) { return a.total_time - b.total_time });

  // Return the routes which are now in the best order.
  return trip_runs;
}


async function do_demo() {
  var trips = await compute_routes([38.9325711,-77.0329266], [38.90052704015674,-77.0422745260422]);
  //var trips = await compute_routes([38.8953272,-77.02106850000001], [38.8958052,-77.07190789999999]);
  trips = await get_trip_predictions(trips);

  trips.forEach(function(trip) {
    console.log("At", trip.stop.name,
                "a", trip.route_name,
                "is arriving in", trip.prediction, "minutes",
                //"(that's", parseInt(trip.time_to_spare), "minutes to spare)",
                "(" + (trip.transfer_stop ? "transfer at " + trip.transfer_stop.name + " and " : "") + "get off at", trip.end_stop.name, ")",
                "with an ETA of", parseInt(trip.total_time), "minutes",
                "(" + parseInt(trip.total_walking_time), "min. walking)",
                );
  })
}

load_initial_data()
  .then(do_demo)

