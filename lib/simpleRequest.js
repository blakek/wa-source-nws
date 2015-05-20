var fs = require('fs')
  , url = require('url')
  , http = require('http')
  , https = require('https');

module.exports = function (uri, on_complete) {
	var output = '';
	var protocol;

	var parsed_uri = url.parse(uri);

	if (parsed_uri.protocol === 'file:') {
		on_complete(fs.readFileSync(uri.slice(7)));
		return;
	} else if (parsed_uri.protocol === 'https:') {
		protocol = https;
	} else if (parsed_uri.protocol === 'http:') {
		protocol = http;
	}

	parsed_uri.headers = { 'User-Agent': 'weather-aware' };

	protocol.get(parsed_uri, function (res) {
		res.setEncoding('UTF-8');

		res.on('data', function (data) {
			output += data;
		});

		res.on('end', function (data) {
			on_complete(output);
		});
	});
};