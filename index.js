var fs = require('fs')
  , path = require('path')
  , async = require('async')
  , xmldoc = require('xmldoc')
  , geolib = require('geolib')
  , moment = require('moment');

var STORM_URI      = '/testing/nws-national-alerts.xml'
  , LOCAL_JSON_URI = '/testing/nws-local.json'
  , LOCAL_XML_URI  = '/testing/nws-local-test.xml';

var lastCall = 0
  , cacheTime = 60
  , lastResults = {};

var options = {
	alertRange: 50
};

function now() {
	return Math.floor(Date.now() / 1000);
}

function parseURI(uri, location) {
	return uri.replace(/\$\{latitude\}/g, location.latitude)
	          .replace(/\$\{longitude\}/g, location.longitude);
}

function findNearestStorms(location, callback) {
	// National alerts
	var na = fs.readFileSync(__dirname + parseURI(STORM_URI, location))
	  , nadoc = new xmldoc.XmlDocument(na);

	var closestStorm = {}
	  , closestStormDistance
	  , closestStormBearing
	  , allAlerts = []
	  , nearbyAlerts = [];

	nadoc.childrenNamed('entry').forEach(function (n) {
		var alert = {
			title: n.valueWithPath('title'),
			event: n.valueWithPath('cap:event'),
			effective: moment(n.valueWithPath('cap:effective')).format('X'),
			expires: moment(n.valueWithPath('cap:expires')).format('X'),
			summary: n.valueWithPath('summary'),
			link: n.valueWithPath('link@href'),
			polygon: []
		};

		n.valueWithPath('cap:polygon').split(' ').forEach(function (point) {
			if (point === '') {
				return;
			}

			var pointParts = point.split(',');
			var loc = {
				latitude: pointParts[0],
				longitude: pointParts[1]
			};

			alert.polygon.push(loc);

			var distance = geolib.convertUnit('mi', geolib.getDistance(location, loc));

			if (closestStorm.event === undefined || distance < closestStormDistance) {
				closestStorm = alert;
				closestStorm.distance = distance;
				closestStorm.bearing = geolib.getBearing(location, loc);
			}
		});

		if (geolib.isPointInside(location, alert.polygon)) {
			alert.distance = 0;
			nearbyAlerts.push(alert);
		} else {
			alert.polygon.some(function (point) {
				var distance = geolib.convertUnit('mi', geolib.getDistance(location, point));
				if (distance < options.alertRange) {
					alert.distance = distance;
					nearbyAlerts.push(alert);
				}
				return true; // Go to next alert if one of the points of this alert is within the search radius
			});
		}

		allAlerts.push(alert);
	});

	callback(null, {
		closestStorm: closestStorm,
		allAlerts: allAlerts,
		nearbyAlerts: nearbyAlerts
	});
}

function getLocalWeatherJSON(location, callback) {
	// Local conditions (part 2)
	callback(null, JSON.parse(fs.readFileSync(__dirname + parseURI(LOCAL_JSON_URI, location))));
}

function getLocalWeatherXML(location, callback) {
	// Local conditions (part 1)
	var doc = new xmldoc.XmlDocument(fs.readFileSync(__dirname + parseURI(LOCAL_XML_URI, location)).toString())
	  , parameters = doc.descendantWithPath('data.parameters')
	  , temps = {}
	  , pops_hourly = [];

	parameters.childrenNamed('temperature').forEach(function (n) {
		temps[n.attr.type] = n;
	});

	parameters.childNamed('probability-of-precipitation').childrenNamed('value').forEach(function (pop) {
		pops_hourly.push(pop.val);
	});

	callback(null, {
		parameters: parameters,
		temps: temps,
		pops_hourly: pops_hourly
	});
}

function getWeatherData(location, on_finish) {
	var remainingTime = lastCall + cacheTime - now();

	if (remainingTime > 0) {
		console.info('nws-testing: using cached results for ' + remainingTime + ' more seconds.');
		on_finish(lastResults);
		return;
	} else {
		lastCall = now();
	}

	async.parallel(
		{
			j: function (cb) {
				getLocalWeatherJSON(location, cb);
			},
			x: function (cb) {
				getLocalWeatherXML(location, cb);
			},
			s: function (cb) {
				findNearestStorms(location, cb);
			}
		},
		function (err, results) {
			if (err) {
				return { error: err };
			}

			lastResults = {
				last_updated: now(),
				location: {
					latitude: results.j.location.latitude,
					longitude: results.j.location.longitude,
					name: results.j.location.areaDescription
				},
				nearest_storm: results.s.closestStorm,
				nearby_wwa: { // Nearby watches, warnings, and alerts
					alerts: results.s.nearbyAlerts,
					count: (results.s.nearbyAlerts) ? (results.s.nearbyAlerts.length) : 0,
					radius: options.alertRange
				},
				now: {
					temp: results.x.temps.hourly.valueWithPath('value'),
					temp_apparent: results.x.temps.apparent.valueWithPath('value'),
					conditions: results.j.currentobservation.Weather,
					icon: nws2waIcon(results.x.parameters.childNamed('conditions-icon').valueWithPath('icon-link')),
					precipitation: {
						probability: results.j.data.pop[0]
					},
					wind: {
						speed: results.j.currentobservation.Winds,
						bearing: results.j.currentobservation.Windd
					}
				},
				today: {
					temp: {
						high: results.x.temps.maximum.valueWithPath('value'),
						low: results.x.temps.minimum.valueWithPath('value')
					},
					summary: results.j.data.text[0],
					icon: nws2waIcon(results.j.data.iconLink[0])
				}
			};

			if (typeof results.j.hazard !== 'undefined') {
				results.j.hazard.forEach(function (hazard, index) {
					lastResults.alerts.push({
						title: hazard,
						uri: results.j.hazardUrl[index]
					});

					lastResults.alerts.push(hazard);
				});
			} else {
				lastResults.alerts = [];
				lastResults.alert_count = 0;
			}

			on_finish(lastResults);
		}
	);
}

function nws2waIcon(origText) {
	var origIcon = path.basename(origText, path.extname(origText)).match(/[a-zA-Z\-]+/g).toString();

	switch (origIcon) {
		case 'bkn':
		case 'nbkn':
		case 'ovc':
		case 'novc':
			return 'cloudy';
		case 'skc':
			return 'day-sunny';
		case 'nskc':
			return 'night-clear';
		case 'few':
			return 'day-sunny-overcast';
		case 'sct':
			return 'day-cloudy';
		case 'nfew':
		case 'nsct':
			return 'night-cloudy';
		case 'fg':
		case 'nfg':
			return 'fog';
		case 'fzra':
		case 'ip':
		case 'mix':
		case 'raip':
		case 'rasn':
		case 'fzrara':
			return 'rain-mix';
		case 'nmix':
		case 'nrasn':
			return 'night-rain-mix';
		case 'shra':
		case 'hi_shwrs':
		case 'hi_nshwrs':
		case 'ra1':
		case 'nra':
			return 'showers';
		case 'tsra':
		case 'hi_tsra':
			return 'storm-showers';
		case 'ntsra':
		case 'hi_ntsra':
			return 'night-alt-storm-showers';
		case 'sn':
			return 'day-snow';
		case 'nsn':
			return 'night-snow';
		case 'wind':
		case 'nwind':
			return 'strong-wind';
		case 'ra':
		case 'nra':
			return 'wi-rain';
		case 'nsvrtsra':
			return 'tornado';
		case 'mist':
			return 'dust';
		default:
			return origIcon;
	}
}

module.exports = {
	source: {
		id: 'nws-testing', // What we use to identify this source (required)
		name: 'National Weather Service (under testing)', // Human-readable name of the source (required)
		enabled: true, // Should this be shown as an option to users (requred for now)
		source_site: 'http://www.weather.gov/', // Website of source for info (optional)
		last_call: undefined // Last time this source was called. Used for caching request results (esp. to keep from using up free API keys)
	},
	getWeatherData: getWeatherData,
	options: options
};

/*
{
	last_updated: now(),
	location: {
		latitude: result_object.latitude,
		longitude: result_object.longitude
	},
	now: {
		temp: Math.round(result_object.currently.temperature),
		temp_apparent: Math.round(result_object.currently.apparentTemperature),
		conditions: result_object.currently.summary,
		icon: forecast_io2waIcon(result_object.currently.icon),
		nearest_storm: {
			bearing: result_object.currently.nearestStormBearing || 0,
			distance: result_object.currently.nearestStormDistance || 0
		},
		precipitation: {
			intensity: result_object.currently.precipIntensity,
			probability: Math.round(result_object.currently.precipProbability * 100),
			type: result_object.currently.precipType
		},
		wind: {
			speed: Math.round(result_object.currently.windSpeed),
			bearing: result_object.currently.windBearing
		}
	},
	today: {
		temp: {
			high: Math.round(result_object.daily.data[0].temperatureMax),
			low: Math.round(result_object.daily.data[0].temperatureMin)
		},
		sun: {
			rise_time: result_object.daily.data[0].sunriseTime,
			set_time: result_object.daily.data[0].sunsetTime
		},
		summary: result_object.hourly.summary,
		icon: forecast_io2waIcon(result_object.hourly.icon),
		hourly: function () { // will contain precipitation, temp, and other hourly data
			var r = [];

			result_object.hourly.data.forEach(function (hour_data) {
				r.push({
					temp: Math.round(hour_data.temperature),
					precipitation: {
						intensity: hour_data.precipIntensity,
						probability: Math.round(hour_data.precipProbability * 100),
						type: hour_data.precipType
					},
					sun: {
						rise_time: hour_data.sunriseTime,
						set_time: hour_data.sunsetTime
					},
					wind: {
						bearing: hour_data.windBearing,
						speed: Math.round(hour_data.windSpeed)
					},
					summary: hour_data.summary,
					icon: forecast_io2waIcon(hour_data.icon),
					time: hour_data.time
				});
			});
			return r;
		}
	},
	week: {
		daily: function() {
			var r = [];

			result_object.daily.data.forEach(function (day_data) {
				r.push({
					temp: {
						high: Math.round(day_data.temperatureMax),
						low: Math.round(day_data.temperatureMin)
					},
					precipitation: {
						intensity: day_data.precipIntensity,
						probability: Math.round(day_data.precipProbability * 100),
						type: day_data.precipType
					},
					sun: {
						rise_time: day_data.sunriseTime,
						set_time: day_data.sunsetTime
					},
					wind: {
						bearing: day_data.windBearing,
						speed: Math.round(day_data.windSpeed)
					},
					summary: day_data.summary,
					icon: forecast_io2waIcon(day_data.icon),
					time: day_data.time
				});
			});
			return r;
		}
	},
	alerts: result_object.alerts,
	alert_count: (result_object.alerts) ? (result_object.alerts.length) : 0,
	units: {
		temp: 'F',
		distance: 'mi',
		speed: 'mph'
	}
}
 */
