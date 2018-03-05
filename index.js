var express = require("express");
var alexa = require("alexa-app");
var express_app = express();

var trip_planner = require("./trip-planner.js");

var app = new alexa.app("transit_trips");

// Utility functions.

// Construct addresses from the slots.
function make_address(request, prefix) {
  var addr = request.slot(prefix+"_street");
  if (request.slot(prefix+"_city"))
    addr += " " + request.slot(prefix+"_city");
  if (request.slot(prefix+"_state"))
    addr += " " + request.slot(prefix+"_state");
  return addr;
}

// Format prediction response.
function say_predictions(tripinfo, response, options) {
  var text = "";

  if (options.restate_addresses)
    text += " You asked for times for trips from " + tripinfo.start.name + " and going to " + tripinfo.end.name + ". ";

  if (tripinfo.trips.length == 0) {
    text += "I couldn't find any upcoming busses or trains.";
  } else {
    var count = 0;
    for (var i = 0; i < tripinfo.trips.length; i++) {
      var trip = tripinfo.trips[i];
      if (typeof trip.prediction === "undefined") continue; // possible route but no upcoming vehicle
      if (count > 3) continue;
      text += ("At " + trip.stop.name + " a " + trip.route_name
        + " is arriving in " + trip.prediction + " minutes. ");
      count++;
    }
  }

  response.say(text);
}

// Intents.

app.launch(function(request, response) {
  var trips = request.getSession().get("trips");
  if (!trips)
    response.say("Start by adding a trip. For instance, say 'add trip named work' to get started.");
  else
    response.say("You have " + trips.length + " trips stored. You can add a trip or list trips.")
  response.shouldEndSession(false);
});

app.intent("times_from_addresses", {
    "slots": {
      "from_street": "AMAZON.PostalAddress",
      "from_city": "AMAZON.US_CITY",
      "from_state": "AMAZON.US_STATE",
      "to_street": "AMAZON.PostalAddress",
      "to_city": "AMAZON.US_CITY",
      "to_state": "AMAZON.US_STATE",
    },
    "utterances": ["for times from {-|from_street} {-|from_city} {-|from_state} to {-|to_street} {-|to_city} {-|to_state}"]
  },
  async function(request, response) {
    // Clear state.
    request.getSession().clear("add_trip");

    // Get upcoming trips.
    var tripinfo = await trip_planner.get_upcoming_trips(
      make_address(request, "from"),
      make_address(request, "to"));
    say_predictions(tripinfo, response, { restate_addresses: true });
  }
);

app.intent("list_trips", { }, function(request, response) {
  var trips = request.getSession().get("trips");
  if (trips)
    response.say("You have " + trips.length + " trips.")
  else
    response.say("You don't have any trips yet. Start by saying 'add trip named work'.")
  response.shouldEndSession(false);
  request.getSession().clear("add_trip");
})

app.intent("add_trip", {
    "slots": {
      "name": "AMAZON.LITERAL",
    },
    "utterances": ["add trip named {-|name}"]
  },
  function(request, response) {
    // Start a new conversation to add a trip with the given name.
    request.getSession().set("add_trip", { name: request.slot("trip_name") });
    response.shouldEndSession(false);
    response.say("What is the address of where you're leaving from when you go to " + request.slot("trip_name") + "? Say the street, city, and state.");
  }
);

app.intent("address", {
    "slots": {
      "address_street": "AMAZON.PostalAddress",
      "address_city": "AMAZON.US_CITY",
      "address_state": "AMAZON.US_STATE",
    },
    "utterances": ["{-|street} {-|city} {-|state}"]
  },
  async function(request, response) {
    var state = request.getSession().get("add_trip");
    if (!state) {
      response.say("Sorry I heard an address but don't know why.")
      response.shouldEndSession(false);
      return;
    }

    if (!state.from_address) {
      state.from_address = make_address(request, "address");
      request.getSession().set("add_trip", state);
      response.say("And what is the address of where you're going to when you go to " + state.name + "? Say a street, city, and state.");
    } else {
      request.getSession().clear("add_trip");

      // Get variables.
      var trip_name = state.name;
      var from_address = state.from_address;
      var to_address = make_address(request, "address");
      
      // Compute routes.
      var tripinfo = await trip_planner.compute_routes(from_address, to_address);
      tripinfo.name = trip_name;

      // Store in session.
      var trips = (request.getSession().get("trips") || []);
      trips.push(tripinfo);
      request.getSession().set("trips", trips);

      response.say("I've added a trip named " + trip_name + " from " + tripinfo.start.name + " to " + tripinfo.end.name + " with " + tripinfo.trips.length + " routes."
        + " To get the times, say 'check times to " + trip_name + "'." );
    }

    response.shouldEndSession(false);
  }
);

app.intent("do_trip", {
    "slots": {
      "name": "AMAZON.LITERAL",
    },
    "utterances": ["get times for {-|trip_name}"]
  },
  async function(request, response) {
    request.getSession().clear("add_trip");
    response.shouldEndSession(false);

    // Is this name the name of a trip?
    var trip_name = request.slot("trip_name");
    var trips = (request.getSession().get("trips") || []);
    for (var i = 0; i < trips.length; i++) {
      if (trips[i].name == trip_name) {
        var predictions = await trip_planner.get_predictions(trips[i]);
        say_predictions(predictions, response, {});
        return;
      }
    }
    
    response.say("You don't have a trip named " + trip_name + ".");
  }
);

// setup the alexa app and attach it to express before anything else
app.express({ expressApp: express_app }); 

express_app.listen(3000, () => console.log('Example app listening on port 3000!'))

console.log(app.schemas.skillBuilder())
