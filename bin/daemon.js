var fs = require('fs');
var url = require('url');
var http = require('http');
var https = require('https');
var readline = require('readline');
var querystring = require('querystring');
var child_process = require('child_process');

var VERSION = 17;

function isValidOrigin(origin) {
  return /^https?:\/\/(?:(?:\w+\.)?figma.com|localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
}

function readResourceFork(file, callback) {
  var child = child_process.spawn(__dirname + '/../MacOS/FigmaDaemon', ['--extract-resource-fork', file]);
  var chunks = [];

  child.stdout.on('data', function(chunk) {
    chunks.push(chunk);
  });

  child.on('close', function(code) {
    if (code === 0) {
      return callback(Buffer.concat(chunks), null);
    }

    callback(null, new Error('FigmaDaemon exited with code: ' + code))
  });

  child.on('error', function() {
    callback(null, new Error('FigmaDaemon is inaccessible'));
  });
}

function handleRequest(request, response) {
  function acceptWithJSON(json) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify(json));
  }

  function acceptWithBinary(buffer) {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': 'application/octet-stream',
    });
    response.end(buffer);
  }

  function ignore(comment) {
    console.log('ignoring: ' + comment);
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end();
  }

  console.log(request.method + ' ' + request.url);
  if (!fonts) {
    return ignore('ignoring request before font data is present');
  }

  // Don't expose this API to everyone
  if (request.method !== 'GET') {
    return ignore('invalid method: ' + request.method);
  }

  var requestURL = url.parse(request.url);
  if (!requestURL) {
    return ignore();
  }

  // Note: Origin can contain multiple whitespace separated origins due to
  // redirects, but that shouldn't happen for us. If it does happen, the
  // isValidOrigin check below will fail.
  var origin = request.headers.origin;
  if (!origin || origin === 'null') {
    origin = null;

    // Fallback to Referer.
    if (request.headers.referer) {
      var refererURL = url.parse(request.headers.referer);
      if (refererURL.protocol && refererURL.host) {
        origin = refererURL.protocol + '//' + refererURL.host;
      }
    }
  }

  if (typeof origin === 'string' &&
      origin.startsWith('chrome-extension://') &&
      requestURL.pathname === '/figma/font-files') {
    // Allow the /figma/font-files route for all Chrome extensions. This
    // is used by the Grab extension.
  } else if (!origin || !isValidOrigin(origin)) {
    return ignore('invalid origin: ' + origin);
  }

  // Whitelist certain URLs
  switch (requestURL.pathname) {
    case '/figma/version': {
      return acceptWithJSON({ version: VERSION });
    }

    case '/figma/font-files': {
      return acceptWithJSON({ version: VERSION, fontFiles: fonts });
    }

    case '/figma/update': {
      var query = querystring.parse(requestURL.query);
      if (!query || !query.version) {
        return ignore('missing version');
      }
      if (+query.version === (query.version | 0)) {
        if (+query.version > VERSION) {
          console.log('CHECK FOR UPDATES'); // The parent process is monitoring our stdout and will see this
        }
        return acceptWithJSON({ version: VERSION });
      }
      return ignore('invalid version: ' + query.version);
    }

    // Whitelist served files
    case '/figma/font-file': {
      var query = querystring.parse(requestURL.query);
      if (!query || !query.file) {
        return ignore('missing file');
      }
      if (fonts.hasOwnProperty(query.file)) {
        try {
          var buffer = fs.readFileSync(query.file);
          if (buffer.length > 0) {
            return acceptWithBinary(buffer);
          }
          return readResourceFork(query.file, function(buffer, error) {
            if (buffer) {
              return acceptWithBinary(buffer);
            }
            ignore('failed to find resource fork: ' + error);
          });
        } catch (e) {
        }
      }
      return ignore('invalid file: ' + query.file);
    }

    default: {
      return ignore('invalid url: ' + requestURL.pathname);
    }
  }
}

function startServer(line) {
  var parts = line.split(';');
  var httpsOptions = {
    pfx: new Buffer(parts[0], 'base64'),
    passphrase: parts[1],
  };

  console.log('starting server');

  const initServer = (server, port) => {
    const listen = () => server.listen(port, 'localhost');

    server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        // Try again after a short delay.
        setTimeout(listen, 1000 * 10);
      } else {
        throw error;
      }
    });

    listen();
  };

  // HTTP for browsers that support 127.0.0.1 without triggering the mixed
  // content blocker.
  httpServer = http.createServer(handleRequest);
  initServer(httpServer, 18412);

  // ... and HTTPS for everything else.
  httpsServer = https.createServer(httpsOptions, handleRequest);
  initServer(httpsServer, 7335);

  handleLine = function(line) {
    fonts = JSON.parse(line);
  };
}

var fonts = null;
var httpServer = null;
var httpsServer = null;
var handleLine = startServer;

// Drive events from the parent daemon process
readline.createInterface({
  input: process.stdin,
  terminal: false
}).on('line', function(line) {
  console.log('got ' + line.length + ' bytes');
  handleLine(line);
});

// Make sure this child process is killed when the parent process exits.
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('end', function() {
  process.exit();
});
