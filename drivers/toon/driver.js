var Toon = require('node-toon');
var request = require("request");

var devices = [];
var toons = [];

/**
 * Find Toon
 * @param devices (already installed)
 * @param callback
 */
module.exports.init = function (devices_data, callback) {

	// Loop over all installed devices and add them
	for (var x = 0; x < devices_data.length; x++) {
		if (devices_data[x].hasOwnProperty("id")) {
			addDevice(devices_data[x]);
		}
	}

	// Add device, if not already added
	function addDevice(device_data) {
		var toon = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET);
		if (Homey.manager('settings').get('toon_access_token') != null) toon.access_token = Homey.manager('settings').get('toon_access_token');
		toon.getAgreements(function (err, data) {

			for (var i = 0; i < data.length; i++) {
				if (data[i].agreementId == device_data.id) {
					toon.setAgreement(data[i].agreementId);
					var device = {
						name: "Toon",
						data: {
							id: device_data.id
						}
					};
					devices.push(device);
					toons.push({id: device.data.id, toon: toon});
				}
			}
		});
	};

	// Start listening for changes
	startPolling();

	// Ready
	callback(null, true);
};

/**
 * Pairing process that calls list_devices when in need of all available Toon devices,
 * here the devices array is built and send to the front-end
 */
module.exports.pair = function (socket) {

	// Create new toon instance
	var toon = new Toon(Homey.env.TOON_KEY, Homey.env.TOON_SECRET);

	// Listen for the start event
	socket.on("start", function (data, callback) {

		Homey.manager('cloud').generateOAuth2Callback('https://api.toonapi.com/authorize?client_id=' + Homey.env.TOON_KEY + '&redirect_uri=https://callback.athom.com/oauth2/callback/&response_type=code',

			// Before fetching authorization code
			function (err, result) {
				callback(err, result);
			},

			// After fetching authorization code
			function (err, result) {
				toon.getAccessToken(result, "https://callback.athom.com/oauth2/callback/", function (err, res, body) {
					toon.access_token = JSON.parse(body).access_token;
					Homey.manager("settings").set("toon_access_token", toon.access_token);
					socket.emit("authenticated", toon.access_token);
				});
			}
		);
	});

	socket.on("list_devices", function (data, callback) {
		socket.on("get_devices", function (devices) {
			for (var i = 0; i < devices.length; i++) {
				devices[i].name = devices[i].data.name_long
			}
			callback(null, devices);
		});
	});

	// Return the found toon instances
	socket.on("get_toon", function (data, callback) {

		// Get all devices hooked up to this account
		toon.getAgreements(function (err, data) {
			if (!err && data != null && data.length > 0) {
				var temp_devices = [];

				for (var i = 0; i < data.length; i++) {
					if (getDevice(data[i].agreementId) == null) {
						temp_devices.push({
							name: "Toon",
							data: {
								id: data[i].agreementId,
								name_long: "Toon: " + data[i].street + " " + data[i].houseNumber + ", " + data[i].postalCode + " " + data[i].city.charAt(0) + data[i].city.slice(1).toLowerCase()
							}
						});
					}
				}
				callback(null, temp_devices);
			}
			else {
				callback(true, null);
			}
		});
	});

	// Add selected toon to Homey
	socket.on("add_toon", function (device, callback) {

		// Set toon to the chosen device
		toon.setAgreement(device.data.id);

		// Store device globally
		devices.push(device);

		// Store reference to toon instance
		toons.push({id: device.data.id, toon: toon});
	});

	socket.on("add_device", function (device, callback) {

		// Set toon to the chosen device
		toon.setAgreement(device.data.id);

		// Store device globally
		devices.push(device);

		// Store reference to toon instance
		toons.push({id: device.data.id, toon: toon});
	})
};

/**
 * These functions represent the capabilities of Toon
 */
module.exports.capabilities = {

	target_temperature: {

		get: function (device_data, callback) {
			if (device_data instanceof Error) return callback(device_data);
			var toon = getToon(device_data.id);
			toon = (toon != null && toon.hasOwnProperty("toon")) ? toon.toon : null;
			if (toon != null) {
				toon.getTargetTemperature(function (err, result) {
					callback(err, (result / 100));
				});
			}
			else {
				callback(true, null);
			}
		},

		set: function (device_data, temperature, callback) {
			if (device_data instanceof Error) return callback(device_data);
			var toon = getToon(device_data.id);
			toon = (toon != null && toon.hasOwnProperty("toon")) ? toon.toon : null;
			if (toon != null) {
				toon.setTemperature(Math.round(temperature * 2) / 2, function (err, result) {
					callback(err, result);
				});
			}
			else {
				callback(true, null);
			}
		}
	},

	measure_temperature: {

		get: function (device_data, callback) {
			if (device_data instanceof Error) return callback(device_data);
			var toon = getToon(device_data.id);
			toon = (toon != null && toon.hasOwnProperty("toon")) ? toon.toon : null;
			if (toon != null) {
				toon.getMeasureTemperature(function (err, result) {
					callback(err, (result / 100));
				});
			}
			else {
				callback(true, null);
			}
		}
	}
};

/**
 * Toon doesn't support realtime, therefore we have to poll
 * for changes considering the measured/target temperature
 */
function startPolling() {
	setInterval(function () {
		for (var i = 0; i < devices.length; i++) {
			var device = devices[i];

			var toon = getToon(device.data.id);
			if (toon != null) toon = toon.toon;

			// Check for updated target temperature
			toon.getTargetTemperature(function (err, result) {
				var updatedTemperature = result / 100;
				if (updatedTemperature != device.data.target_temperature) module.exports.realtime(device.data, "target_temperature", updatedTemperature);
				device.data.target_temperature = result / 100;
			});

			// Check for updated measured temperature
			toon.getMeasureTemperature(function (err, result) {
				var updatedTemperature = result / 100;
				if (updatedTemperature != device.data.measure_temperature) module.exports.realtime(device.data, "measure_temperature", updatedTemperature);
				device.data.measure_temperature = result / 100;
			});
		}
	}, 20000);
}

/**
 * Delete devices internally when users removes one
 * @param device_data
 */
module.exports.deleted = function (device_data) {
	var device = getDevice(device_data.id);
	var toon = getToon(device_data.id);

	// Find toon and delete
	var toon_index = toons.indexOf(toon);
	if (toon_index > -1) {
		toons.splice(toon_index, 1);
	}

	// Find device and delete
	var device_index = devices.indexOf(device);
	if (device_index > -1) {
		devices.splice(device_index, 1);
	}
};

/**
 * Gets a device based on an id
 * @param device_id
 * @returns {*}
 */
function getDevice(device_id) {
	for (var x = 0; x < devices.length; x++) {
		if (devices[x].data.id === device_id) {
			return devices[x];
		}
	}
};

/**
 * Gets the toon socket instance based on device id
 * @param device_id
 * @returns {*}
 */
function getToon(device_id) {
	for (var x = 0; x < toons.length; x++) {
		if (toons[x].id === device_id) {
			return toons[x];
		}
	}
};
