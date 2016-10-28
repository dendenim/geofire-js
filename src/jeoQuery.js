/**
 * Creates a JeoQuery instance.
 *
 * @constructor
 * @this {JeoQuery}
 * @param {Firebase} firebaseRef A Firebase reference.
 * @param {Object} queryCriteria The criteria which specifies the query's center and radius.
 */
var JeoQuery = function (firebaseRef, queryCriteria) {
  /*********************/
  /*  PRIVATE METHODS  */
  /*********************/
  /**
   * Fires each callback for the provided eventType, passing it provided key's data.
   *
   * @param {string} eventType The event type whose callbacks to fire. One of "key_entered", "key_exited", or "key_moved".
   * @param {string} key The key of the location for which to fire the callbacks.
   * @param {?Array.<number>} location The location as [latitude, longitude] pair
   * @param {?double} distanceFromCenter The distance from the center or null.
   */
  function _fireCallbacksForKey(eventType, key, location, distanceFromCenter) {
    _callbacks[eventType].forEach(function(callback) {
      if (typeof location === "undefined" || location === null) {
        callback(key, null, null);
      }
      else {
        callback(key, location, distanceFromCenter);
      }
    });
  }

  /**
   * Fires each callback for the "ready" event.
   */
  function _fireReadyEventCallbacks() {
    _callbacks.ready.forEach(function(callback) {
      callback();
    });
  }

  /**
   * Decodes a query string to a query
   *
   * @param {string} str The encoded query.
   * @return {Array.<string>} The decoded query as a [start, end] pair.
   */
  function _stringToQuery(string) {
    var decoded = string.split(":");
    if (decoded.length !== 2) {
      throw new Error("Invalid internal state! Not a valid jeohash query: " + string);
    }
    return decoded;
  }

  /**
   * Encodes a query as a string for easier indexing and equality.
   *
   * @param {Array.<string>} query The query to encode.
   * @param {string} The encoded query as string.
   */
  function _queryToString(query) {
    if (query.length !== 2) {
      throw new Error("Not a valid jeohash query: " + query);
    }
    return query[0]+":"+query[1];
  }

  /**
   * Turns off all callbacks for the provide jeohash query.
   *
   * @param {Array.<string>} query The jeohash query.
   * @param {Object} queryState An object storing the current state of the query.
   */
  function _cancelJeohashQuery(query, queryState) {
    var queryRef = _firebaseRef.orderByChild("g").startAt(query[0]).endAt(query[1]);
    queryRef.off("child_added", queryState.childAddedCallback);
    queryRef.off("child_removed", queryState.childRemovedCallback);
    queryRef.off("child_changed", queryState.childChangedCallback);
    queryRef.off("value", queryState.valueCallback);
  }

  /**
   * Removes unnecessary Firebase queries which are currently being queried.
   */
  function _cleanUpCurrentJeohashesQueried() {
    var keys = Object.keys(_currentJeohashesQueried);
    var numKeys = keys.length;
    for (var i = 0; i < numKeys; ++i) {
      var jeohashQueryStr = keys[i];
      var queryState = _currentJeohashesQueried[jeohashQueryStr];
      if (queryState.active === false) {
        var query = _stringToQuery(jeohashQueryStr);
        // Delete the jeohash since it should no longer be queried
        _cancelJeohashQuery(query, queryState);
        delete _currentJeohashesQueried[jeohashQueryStr];
      }
    }

    // Delete each location which should no longer be queried
    keys = Object.keys(_locationsTracked);
    numKeys = keys.length;
    for (i = 0; i < numKeys; ++i) {
      var key = keys[i];
      if (!_jeohashInSomeQuery(_locationsTracked[key].jeohash)) {
        if (_locationsTracked[key].isInQuery) {
          throw new Error("Internal State error, trying to remove location that is still in query");
        }
        delete _locationsTracked[key];
      }
    }

    // Specify that this is done cleaning up the current jeohashes queried
    _jeohashCleanupScheduled = false;

    // Cancel any outstanding scheduled cleanup
    if (_cleanUpCurrentJeohashesQueriedTimeout !== null) {
      clearTimeout(_cleanUpCurrentJeohashesQueriedTimeout);
      _cleanUpCurrentJeohashesQueriedTimeout = null;
    }
  }

  /**
   * Callback for any updates to locations. Will update the information about a key and fire any necessary
   * events every time the key's location changes.
   *
   * When a key is removed from JeoFire or the query, this function will be called with null and performs
   * any necessary cleanup.
   *
   * @param {string} key The key of the jeofire location.
   * @param {?Array.<number>} location The location as [latitude, longitude] pair.
   */
  function _updateLocation(key, location) {
    validateLocation(location);
    // Get the key and location
    var distanceFromCenter, isInQuery;
    var wasInQuery = (_locationsTracked.hasOwnProperty(key)) ? _locationsTracked[key].isInQuery : false;
    var oldLocation = (_locationsTracked.hasOwnProperty(key)) ? _locationsTracked[key].location : null;

    // Determine if the location is within this query
    distanceFromCenter = JeoFire.distance(location, _center);
    isInQuery = (distanceFromCenter <= _radius);

    // Add this location to the locations queried dictionary even if it is not within this query
    _locationsTracked[key] = {
      location: location,
      distanceFromCenter: distanceFromCenter,
      isInQuery: isInQuery,
      jeohash: encodeJeohash(location, g_GEOHASH_PRECISION)
    };

    // Fire the "key_entered" event if the provided key has entered this query
    if (isInQuery && !wasInQuery) {
      _fireCallbacksForKey("key_entered", key, location, distanceFromCenter);
    } else if (isInQuery && oldLocation !== null && (location[0] !== oldLocation[0] || location[1] !== oldLocation[1])) {
      _fireCallbacksForKey("key_moved", key, location, distanceFromCenter);
    } else if (!isInQuery && wasInQuery) {
      _fireCallbacksForKey("key_exited", key, location, distanceFromCenter);
    }
  }

  /**
   * Checks if this jeohash is currently part of any of the jeohash queries.
   *
   * @param {string} jeohash The jeohash.
   * @param {boolean} Returns true if the jeohash is part of any of the current jeohash queries.
   */
  function _jeohashInSomeQuery(jeohash) {
    var keys = Object.keys(_currentJeohashesQueried);
    var numKeys = keys.length;
    for (var i = 0; i < numKeys; ++i) {
      var queryStr = keys[i];
      if (_currentJeohashesQueried.hasOwnProperty(queryStr)) {
        var query = _stringToQuery(queryStr);
        if (jeohash >= query[0] && jeohash <= query[1]) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Removes the location from the local state and fires any events if necessary.
   *
   * @param {string} key The key to be removed.
   * @param {?Array.<number>} currentLocation The current location as [latitude, longitude] pair
   * or null if removed.
   */
  function _removeLocation(key, currentLocation) {
    var locationDict = _locationsTracked[key];
    delete _locationsTracked[key];
    if (typeof locationDict !== "undefined" && locationDict.isInQuery) {
      var distanceFromCenter = (currentLocation) ? JeoFire.distance(currentLocation, _center) : null;
      _fireCallbacksForKey("key_exited", key, currentLocation, distanceFromCenter);
    }
  }

  /**
   * Callback for child added events.
   *
   * @param {Firebase DataSnapshot} locationDataSnapshot A snapshot of the data stored for this location.
   */
  function _childAddedCallback(locationDataSnapshot) {
    _updateLocation(getKey(locationDataSnapshot), decodeJeoFireObject(locationDataSnapshot.val()));
  }

  /**
   * Callback for child changed events
   *
   * @param {Firebase DataSnapshot} locationDataSnapshot A snapshot of the data stored for this location.
   */
  function _childChangedCallback(locationDataSnapshot) {
    _updateLocation(getKey(locationDataSnapshot), decodeJeoFireObject(locationDataSnapshot.val()));
  }

  /**
   * Callback for child removed events
   *
   * @param {Firebase DataSnapshot} locationDataSnapshot A snapshot of the data stored for this location.
   */
  function _childRemovedCallback(locationDataSnapshot) {
    var key = getKey(locationDataSnapshot);
    if (_locationsTracked.hasOwnProperty(key)) {
      _firebaseRef.child(key).once("value", function(snapshot) {
        var location = snapshot.val() === null ? null : decodeJeoFireObject(snapshot.val());
        var jeohash = (location !== null) ? encodeJeohash(location) : null;
        // Only notify observers if key is not part of any other jeohash query or this actually might not be
        // a key exited event, but a key moved or entered event. These events will be triggered by updates
        // to a different query
        if (!_jeohashInSomeQuery(jeohash)) {
          _removeLocation(key, location);
        }
      });
    }
  }

  /**
   * Called once all jeohash queries have received all child added events and fires the ready
   * event if necessary.
   */
  function _jeohashQueryReadyCallback(queryStr) {
    var index = _outstandingJeohashReadyEvents.indexOf(queryStr);
    if (index > -1) {
      _outstandingJeohashReadyEvents.splice(index, 1);
    }
    _valueEventFired = (_outstandingJeohashReadyEvents.length === 0);

    // If all queries have been processed, fire the ready event
    if (_valueEventFired) {
      _fireReadyEventCallbacks();
    }
  }

  /**
   * Attaches listeners to Firebase which track when new jeohashes are added within this query's
   * bounding box.
   */
  function _listenForNewJeohashes() {
    // Get the list of jeohashes to query
    var jeohashesToQuery = jeohashQueries(_center, _radius*1000).map(_queryToString);

    // Filter out duplicate jeohashes
    jeohashesToQuery = jeohashesToQuery.filter(function(jeohash, i){
      return jeohashesToQuery.indexOf(jeohash) === i;
    });

    // For all of the jeohashes that we are already currently querying, check if they are still
    // supposed to be queried. If so, don't re-query them. Otherwise, mark them to be un-queried
    // next time we clean up the current jeohashes queried dictionary.
    var keys = Object.keys(_currentJeohashesQueried);
    var numKeys = keys.length;
    for (var i = 0; i < numKeys; ++i) {
      var jeohashQueryStr = keys[i];
      var index = jeohashesToQuery.indexOf(jeohashQueryStr);
      if (index === -1) {
        _currentJeohashesQueried[jeohashQueryStr].active = false;
      }
      else {
        _currentJeohashesQueried[jeohashQueryStr].active = true;
        jeohashesToQuery.splice(index, 1);
      }
    }

    // If we are not already cleaning up the current jeohashes queried and we have more than 25 of them,
    // kick off a timeout to clean them up so we don't create an infinite number of unneeded queries.
    if (_jeohashCleanupScheduled === false && Object.keys(_currentJeohashesQueried).length > 25) {
      _jeohashCleanupScheduled = true;
      _cleanUpCurrentJeohashesQueriedTimeout = setTimeout(_cleanUpCurrentJeohashesQueried, 10);
    }

    // Keep track of which jeohashes have been processed so we know when to fire the "ready" event
    _outstandingJeohashReadyEvents = jeohashesToQuery.slice();

    // Loop through each jeohash to query for and listen for new jeohashes which have the same prefix.
    // For every match, attach a value callback which will fire the appropriate events.
    // Once every jeohash to query is processed, fire the "ready" event.
    jeohashesToQuery.forEach(function(toQueryStr) {
      // decode the jeohash query string
      var query = _stringToQuery(toQueryStr);

      // Create the Firebase query
      var firebaseQuery = _firebaseRef.orderByChild("g").startAt(query[0]).endAt(query[1]);

      // For every new matching jeohash, determine if we should fire the "key_entered" event
      var childAddedCallback = firebaseQuery.on("child_added", _childAddedCallback);
      var childRemovedCallback = firebaseQuery.on("child_removed", _childRemovedCallback);
      var childChangedCallback = firebaseQuery.on("child_changed", _childChangedCallback);

      // Once the current jeohash to query is processed, see if it is the last one to be processed
      // and, if so, mark the value event as fired.
      // Note that Firebase fires the "value" event after every "child_added" event fires.
      var valueCallback = firebaseQuery.on("value", function() {
        firebaseQuery.off("value", valueCallback);
        _jeohashQueryReadyCallback(toQueryStr);
      });

      // Add the jeohash query to the current jeohashes queried dictionary and save its state
      _currentJeohashesQueried[toQueryStr] = {
        active: true,
        childAddedCallback: childAddedCallback,
        childRemovedCallback: childRemovedCallback,
        childChangedCallback: childChangedCallback,
        valueCallback: valueCallback
      };
    });
    // Based upon the algorithm to calculate jeohashes, it's possible that no "new"
    // jeohashes were queried even if the client updates the radius of the query.
    // This results in no "READY" event being fired after the .updateQuery() call.
    // Check to see if this is the case, and trigger the "READY" event.
    if(jeohashesToQuery.length === 0) {
      _jeohashQueryReadyCallback();
    }
  }

  /********************/
  /*  PUBLIC METHODS  */
  /********************/
  /**
   * Returns the location signifying the center of this query.
   *
   * @return {Array.<number>} The [latitude, longitude] pair signifying the center of this query.
   */
  this.center = function() {
    return _center;
  };

  /**
   * Returns the radius of this query, in kilometers.
   *
   * @return {number} The radius of this query, in kilometers.
   */
  this.radius = function() {
    return _radius;
  };

  /**
   * Updates the criteria for this query.
   *
   * @param {Object} newQueryCriteria The criteria which specifies the query's center and radius.
   */
  this.updateCriteria = function(newQueryCriteria) {
    // Validate and save the new query criteria
    validateCriteria(newQueryCriteria);
    _center = newQueryCriteria.center || _center;
    _radius = newQueryCriteria.radius || _radius;

    // Loop through all of the locations in the query, update their distance from the center of the
    // query, and fire any appropriate events
    var keys = Object.keys(_locationsTracked);
    var numKeys = keys.length;
    for (var i = 0; i < numKeys; ++i) {
      var key = keys[i];

      // If the query was cancelled while going through this loop, stop updating locations and stop
      // firing events
      if (_cancelled === true) {
        break;
      }

      // Get the cached information for this location
      var locationDict = _locationsTracked[key];

      // Save if the location was already in the query
      var wasAlreadyInQuery = locationDict.isInQuery;

      // Update the location's distance to the new query center
      locationDict.distanceFromCenter = JeoFire.distance(locationDict.location, _center);

      // Determine if the location is now in this query
      locationDict.isInQuery = (locationDict.distanceFromCenter <= _radius);

      // If the location just left the query, fire the "key_exited" callbacks
      if (wasAlreadyInQuery && !locationDict.isInQuery) {
        _fireCallbacksForKey("key_exited", key, locationDict.location, locationDict.distanceFromCenter);
      }

      // If the location just entered the query, fire the "key_entered" callbacks
      else if (!wasAlreadyInQuery && locationDict.isInQuery) {
        _fireCallbacksForKey("key_entered", key, locationDict.location, locationDict.distanceFromCenter);
      }
    }

    // Reset the variables which control when the "ready" event fires
    _valueEventFired = false;

    // Listen for new jeohashes being added to JeoFire and fire the appropriate events
    _listenForNewJeohashes();
  };

  /**
   * Attaches a callback to this query which will be run when the provided eventType fires. Valid eventType
   * values are "ready", "key_entered", "key_exited", and "key_moved". The ready event callback is passed no
   * parameters. All other callbacks will be passed three parameters: (1) the location's key, (2) the location's
   * [latitude, longitude] pair, and (3) the distance, in kilometers, from the location to this query's center
   *
   * "ready" is used to signify that this query has loaded its initial state and is up-to-date with its corresponding
   * JeoFire instance. "ready" fires when this query has loaded all of the initial data from JeoFire and fired all
   * other events for that data. It also fires every time updateQuery() is called, after all other events have
   * fired for the updated query.
   *
   * "key_entered" fires when a key enters this query. This can happen when a key moves from a location outside of
   * this query to one inside of it or when a key is written to JeoFire for the first time and it falls within
   * this query.
   *
   * "key_exited" fires when a key moves from a location inside of this query to one outside of it. If the key was
   * entirely removed from JeoFire, both the location and distance passed to the callback will be null.
   *
   * "key_moved" fires when a key which is already in this query moves to another location inside of it.
   *
   * Returns a JeoCallbackRegistration which can be used to cancel the callback. You can add as many callbacks
   * as you would like for the same eventType by repeatedly calling on(). Each one will get called when its
   * corresponding eventType fires. Each callback must be cancelled individually.
   *
   * @param {string} eventType The event type for which to attach the callback. One of "ready", "key_entered",
   * "key_exited", or "key_moved".
   * @callback callback Callback function to be called when an event of type eventType fires.
   * @return {JeoCallbackRegistration} A callback registration which can be used to cancel the provided callback.
   */
  this.on = function(eventType, callback) {
    // Validate the inputs
    if (["ready", "key_entered", "key_exited", "key_moved"].indexOf(eventType) === -1) {
      throw new Error("event type must be \"ready\", \"key_entered\", \"key_exited\", or \"key_moved\"");
    }
    if (typeof callback !== "function") {
      throw new Error("callback must be a function");
    }

    // Add the callback to this query's callbacks list
    _callbacks[eventType].push(callback);

    // If this is a "key_entered" callback, fire it for every location already within this query
    if (eventType === "key_entered") {
      var keys = Object.keys(_locationsTracked);
      var numKeys = keys.length;
      for (var i = 0; i < numKeys; ++i) {
        var key = keys[i];
        var locationDict = _locationsTracked[key];
        if (typeof locationDict !== "undefined" && locationDict.isInQuery) {
          callback(key, locationDict.location, locationDict.distanceFromCenter);
        }
      }
    }

    // If this is a "ready" callback, fire it if this query is already ready
    if (eventType === "ready") {
      if (_valueEventFired) {
        callback();
      }
    }

    // Return an event registration which can be used to cancel the callback
    return new JeoCallbackRegistration(function() {
      _callbacks[eventType].splice(_callbacks[eventType].indexOf(callback), 1);
    });
  };

  /**
   * Terminates this query so that it no longer sends location updates. All callbacks attached to this
   * query via on() will be cancelled. This query can no longer be used in the future.
   */
  this.cancel = function () {
    // Mark this query as cancelled
    _cancelled = true;

    // Cancel all callbacks in this query's callback list
    _callbacks = {
      ready: [],
      key_entered: [],
      key_exited: [],
      key_moved: []
    };

    // Turn off all Firebase listeners for the current jeohashes being queried
    var keys = Object.keys(_currentJeohashesQueried);
    var numKeys = keys.length;
    for (var i = 0; i < numKeys; ++i) {
      var jeohashQueryStr = keys[i];
      var query = _stringToQuery(jeohashQueryStr);
      _cancelJeohashQuery(query, _currentJeohashesQueried[jeohashQueryStr]);
      delete _currentJeohashesQueried[jeohashQueryStr];
    }

    // Delete any stored locations
    _locationsTracked = {};

    // Turn off the current jeohashes queried clean up interval
    clearInterval(_cleanUpCurrentJeohashesQueriedInterval);
  };


  /*****************/
  /*  CONSTRUCTOR  */
  /*****************/
  // Firebase reference of the JeoFire which created this query
  if (Object.prototype.toString.call(firebaseRef) !== "[object Object]") {
    throw new Error("firebaseRef must be an instance of Firebase");
  }
  var _firebaseRef = firebaseRef;

  // Event callbacks
  var _callbacks = {
    ready: [],
    key_entered: [],
    key_exited: [],
    key_moved: []
  };

  // Variable to track when the query is cancelled
  var _cancelled = false;

  // Variables used to keep track of when to fire the "ready" event
  var _valueEventFired = false;
  var _outstandingJeohashReadyEvents;

  // A dictionary of locations that a currently active in the queries
  // Note that not all of these are currently within this query
  var _locationsTracked = {};

  // A dictionary of jeohash queries which currently have an active callbacks
  var _currentJeohashesQueried = {};

  // Every ten seconds, clean up the jeohashes we are currently querying for. We keep these around
  // for a little while since it's likely that they will need to be re-queried shortly after they
  // move outside of the query's bounding box.
  var _jeohashCleanupScheduled = false;
  var _cleanUpCurrentJeohashesQueriedTimeout = null;
  var _cleanUpCurrentJeohashesQueriedInterval = setInterval(function() {
      if (_jeohashCleanupScheduled === false) {
        _cleanUpCurrentJeohashesQueried();
      }
    }, 10000);

  // Validate and save the query criteria
  validateCriteria(queryCriteria, /* requireCenterAndRadius */ true);
  var _center = queryCriteria.center;
  var _radius = queryCriteria.radius;

  // Listen for new jeohashes being added around this query and fire the appropriate events
  _listenForNewJeohashes();
};
