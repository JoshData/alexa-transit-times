var express = require("express");
var alexa = require("alexa-app");
var express_app = express();
var storage = require('node-persist');

var trip_planner = require("./trip-planner.js");

var app = new alexa.app("transit_trips");

storage.initSync();

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

  var count = 0;
  var last_stop = null;
  var seen_modalities = { };
  for (var i = 0; i < tripinfo.trips.length; i++) {
    var trip = tripinfo.trips[i];
    if (typeof trip.arrival === "undefined") continue; // possible route but no upcoming vehicle
    if (count >= 3 && seen_modalities[trip.route.modality]) continue; // first three routes plus the first route of any modality not yet seen
    if (trip.start_stop.name != last_stop)
      text += "At " + trip.start_stop.name + " ";
    else
      text += "Then ";
    text += "a " + trip.route_name_short + " arrives in " + trip.arrival + " minutes. ";
    if (trip.transfer_stop)
      text += "Transfer at " + trip.transfer_stop.name + " to the " + trip.transfer_route.short_name + ". ";
    last_stop = trip.start_stop.name;
    count++;
    seen_modalities[trip.route.modality] = true;
  }

  if (!count) {
    response.say("I couldn't find any upcoming busses or trains.");
    return;
  }

  response.say(text);
}

// Intents.

function get_user_trips(request) {
  var user = storage.getItemSync('user-' + request.userId);
  if (!user) return [];
  return (user.trips || []);
}

function add_user_trip(request, trip) {
  var key = 'user-' + request.userId;
  var user = storage.getItemSync(key);
  if (!user) user = { };
  if (!user.trips) user.trips = [ ];
  
  // Update existing trip by name.
  for (var i = 0; i < user.trips.length; i++) {
    if (user.trips[i].name == trip.name) {
      user.trips[i] = trip;
      storage.setItemSync(key, user);
      return;
    }
  }

  // Remove the oldest if more than 50 trips.
  if (user.trips.length >= 50)
    user.trips.shift();

  // Append.
  user.trips.push(trip);
  storage.setItemSync(key, user);
}

function app_launch_handler(request, response) {
  var trips = get_user_trips(request);
  if (trips.length == 0)
    response.say("Start by adding a trip. For instance, say 'add a trip named work' to get started.");
  else
    response.say(
        "You have " + trips.length + " trip" + (trips.length != 1 ? "s" : "") + " stored. "
      + "You can add list trips, get next transit times by saying check get times to " + trips[0].name + " or check times to " + trips[0].name + ". "
      + "To add a trip, say 'add a trip named' and give it a name. "
      + "Say stop or cancel to exit this skill.")
  response.shouldEndSession(false);
}

app.launch(app_launch_handler);

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
  response.shouldEndSession(false);
  request.getSession().clear("add_trip");
  var trips = get_user_trips(request);
  if (trips.length == 0) {
    response.say("You don't have any trips yet. Start by saying 'add trip named work'.")
    return;
  }

  var text = "You have " + trips.length + " trip" + (trips.length != 1 ? "s" : "") + ": ";
  trips.forEach(function(trip) {
    text += trip.name + ", ";
  })
  text += "."
  response.say(text);
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
      var trip;
      try {
        trip = await trip_planner.compute_routes(from_address, to_address);
        trip.name = trip_name;
      } catch (e) {
        response.say("Sorry, there was a problem.");
        console.log(e);
        return;
      }

      // Store in session.
      add_user_trip(request, trip);

      response.say("I've added a trip named " + trip.name + " from " + trip.start.name + " to " + trip.end.name + " with " + trip.trips.length + " routes."
        + " To get the times, say 'check times to " + trip.name + "'.");
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

    if (request.type() == "IntentRequest")
      response.shouldEndSession(false);

    // Is this name the name of a trip?
    var trip_name = request.slot("trip_name");
    var trips = get_user_trips(request);
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

app.intent("explain_trip", {
    "slots": {
      "name": "AMAZON.LITERAL",
    },
    "utterances": ["what is {-|trip_name}"]
  },
  async function(request, response) {
    request.getSession().clear("add_trip");
    response.shouldEndSession(false);

    // Is this name the name of a trip?
    var trip_name = request.slot("trip_name");
    var trips = get_user_trips(request);
    for (var i = 0; i < trips.length; i++) {
      if (trips[i].name == trip_name) {
        response.say(trip_name + " is your trip from "
          + trips[i].start.name + " to " + trips[i].end.name + ".");
        return;
      }
    }
    
    response.say("You don't have a trip named " + trip_name + ".");
  }
);

async function stop_cancel_intent_handler(request, response) {
  if (request.getSession().get("add_trip")) {
    request.getSession().clear("add_trip");
    app_launch_handler(request, response);
    return;
  }

  response.say("Doors closing!");
}

app.intent("AMAZON.StopIntent", { }, stop_cancel_intent_handler);
app.intent("AMAZON.CancelIntent", { }, stop_cancel_intent_handler);

// setup the alexa app and attach it to express before anything else
app.express({ expressApp: express_app }); 

express_app.listen(3000, () => console.log('App listening on port 3000!'))

//console.log(app.schemas.skillBuilder())
