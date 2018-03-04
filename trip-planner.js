const moment = require("moment");
const momenttz = require("moment-timezone");
const geodist = require('geodist')

// Load WMATA API key.
const fs = require("fs");
var api_key = fs.readFileSync('wmata_api_key.txt').toString("ascii").replace(/[\r\n]*$/, "");

// Generic helper to call WMATA API.
var web_request_cache = { };
function web_request(host, path, qs) {
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
        web_request_cache[path] = body;
        resolve(body);
      });
    }).on('error', (e) => {
      reject(null);
    });
  })
}

function wmata_api(path, qs) {
  return web_request('api.wmata.com', path, qs)
}

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
  var max_search = 10000;
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

    // Take this pair. Call the callback with this pair.
    // If the callback returns false, stop iterating.
    var dist = total_distance(start_stop, end_stop);
    if (!await cb(start_stop, end_stop))
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

async function compute_route(start, end) {
  // Compute the fastest route from start to end. Iterate over the
  // pairs of stops nearest to the end points in ascending order
  // over total distance first assuming no transfers, then assuming
  // one transfer. Only try each route once --- the first pair on
  // that route will be the one with the smallest distance to
  // the start and end points.

  var seen_routes = { };
  var trips = [];

  await iterate_stop_pairs_by_distance(start, end, async function(start_stop, end_stop) {
    // Are these stops on any of the same routes?
    for (let i = 0; i < start_stop.routes.length; i++)
      for (let j = 0; j < end_stop.routes.length; j++)
        if (start_stop.routes[i].id == end_stop.routes[j].id)
          await try_start_stop_route(start_stop, end_stop, start_stop.routes[i]);
    return true;
  });

  async function try_start_stop_route(start_stop, end_stop, route) {
    // Although they are on the same routes, they could be
    // on different directions of the route, or the end stop
    // could precede the start stop (except on a LOOP-directed
    // route, the order does not matter).
    var directions = await route.getDirectionsMetadata();
    for (var i = 0; i < directions.length; i++)
      await try_start_stop_route_direction(start_stop, end_stop, directions[i]);
  }

  async function try_start_stop_route_direction(start_stop, end_stop, direction) {
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
    trips.push({
      route: direction,
      start_stop: start_stop,
      end_stop: end_stop,
      start_walking_time: walking_time(start, start_stop.coord),
      end_walking_time: walking_time(end, end_stop.coord),
      transit_time: duration,
    });
  }

  // For each trip, explode it into copies for each next transit
  // prediction time.
  var cached_predictions = { };
  var trip_runs = [];
  for (var i = 0; i < trips.length; i++) {
    // Get the next bus at the start.
    var trip = trips[i];
    var preds = await trip.route.get_predictions(trip.start_stop, cached_predictions);
    preds.forEach(function(pred) {
      // Skip if the user can't walk there in time. Add an extra
      // buffer minute since the user has to listen to our response
      // and leave the house.
      if (pred < trip.start_walking_time + 1)
        return;

      // Return this trip.
      trip_runs.push({
        route: trip.route,
        stop: trip.start_stop,
        prediction: pred,
        time_to_spare: pred - trip.start_walking_time,
        total_time: pred + trip.transit_time + trip.end_walking_time,
      });
    })
  }

  // Sort by the total time to destination.
  trip_runs.sort(function(a, b) { return a.total_time - b.total_time });

  // Return the routes which are now in the best order.
  return trip_runs;
}

station_stops = null;
async function load_initial_data() {
  station_stops = [];

  var wmata_bus_stops = await wmata_api('/Bus.svc/json/jStops', {});
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
            var routedata = await wmata_api('/Bus.svc/json/jRouteDetails', { RouteID: route });
            var directions = [];
            function make_direction(direction_num, direction) {
              if (direction == null) return; // a route can have either of its directions be null
              directions.push({
                id: routedata.RouteID + "|" + direction_num,
                name: routedata.RouteID + " " + direction.DirectionText + " toward " + direction.TripHeadsign,
                stops: direction.Stops.map(function(stop) { return "wmata_bus:" + stop.StopID }),
                getEstimatedTripTime: async function(start_stop, end_stop) {
                  // Compute the total transit time. Use schedule data for today to find the next trip.
                  var now = moment();
                  var route_schedule = await wmata_api('/Bus.svc/json/jRouteSchedule', { RouteID: route });
                  var runs = route_schedule["Direction" + direction_num];
                  if (!runs)
                    return null; // no schedule for today?
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
                    if (start_time.diff(now) > 0) {
                      var end_time = moment.tz(run[end_stop_index].Time, "America/New_York");
                      return end_time.diff(start_time, "minutes");
                    }
                  }

                  // Found no helpful schedule data.
                  return null;
                },
                get_predictions: async function(stop, cached_predictions) {
                  if (!(stop.raw.StopID in cached_predictions))
                    cached_predictions[stop.raw.StopID] = await wmata_api('/NextBusService.svc/json/jPredictions', { StopID: stop.raw.StopID });
                  var preds = [];
                  cached_predictions[stop.raw.StopID].Predictions.forEach(function(prediction_run) {
                    if ((prediction_run.RouteID == route) && (prediction_run.DirectionNum == direction_num))
                      preds.push(prediction_run.Minutes);
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
      raw: stop
    });
  });
};

async function do_demo() {
  var trip = await compute_route([38.9325711,-77.0329266], [38.90052704015674,-77.0422745260422]);
  trip.forEach(function(trip) {
    console.log("Take the", trip.route.name,
                "at", trip.stop.name,
                "arriving in", trip.prediction, "minutes",
                "(that's", parseInt(trip.time_to_spare), "minutes to spare)",
                "with an ETA of", parseInt(trip.total_time), "minutes.",
                );
  })
}

load_initial_data()
  .then(do_demo)

