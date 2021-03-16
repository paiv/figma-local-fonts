// daemon.js
var fs = require('fs');
var url = require('url');
var http = require('http');
var querystring = require('querystring');

var VERSION = 17;

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
  origin = '*';

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
}

var fonts = null;
var httpServer = null;

function scanfontsjs(root = '.') {
    // scanfonts.js
    const fs = require('fs')
    const path = require('path')

    function parse_font_file(fn) {
        let data = fs.readFileSync(fn)
        const sig = data.readUInt32BE(0)
        if (sig === 0x74746366) { // ttcf
            let spec = analyze_font_collection(data)
            if (spec && spec.length) {
                return spec
            }
            return
        }
        let spec = analyze_font(data)
        if (spec) {
            return [spec]
        }
    }

    function analyze_font_collection(data) {
        const major = data.readUInt16BE(4)
        const minor = data.readUInt16BE(6)
        if ((major !== 1 && major !== 2) || (minor !== 0)) { return }
        const nfonts = data.readUInt32BE(8)
        let fonts = []
        for (let i = 0, off = 12; i < nfonts; ++i, off += 4) {
            const p = data.readUInt32BE(off)
            let font = analyze_font(data, p)
            if (font) {
                fonts.push(font)
            }
        }
        return fonts
    }

    function analyze_font(data, tableOffset=0) {
        const sig = data.readUInt32BE(tableOffset+0)
        if (sig !== 0x4F54544F) { // OTTO
            const major = data.readUInt16BE(tableOffset+0)
            const minor = data.readUInt16BE(tableOffset+2)
            if (major !== 1 || minor !== 0) { return }
        }

        const ntables = data.readUInt16BE(tableOffset+4)
        let offsets = new Map()
        for (let i = 0, off = tableOffset+12; i < ntables; ++i, off += 16) {
            const tag = data.subarray(off, off+4).toString('utf-8')
            const p = data.readUInt32BE(off+8)
            offsets.set(tag, p)
        }
        {
            const p = offsets.get('head')
            let buf = data.subarray(p, p + 16)
            const major = buf.readUInt16BE(0)
            const minor = buf.readUInt16BE(2)
            if (major !== 1 || minor !== 0) { return }
            const magic = buf.readUInt32BE(12)
            if (magic != 0x5F0F3CF5) { return }
        }

        const head = offsets.get('head')
        const macStyle = data.readUInt16BE(head+44)

        let attribs = {italic:((macStyle & 2) !== 0)}

        {
            const nameids = new Map([[1, 'family'], [2, 'style'], [6, 'postscript']])
            const name = offsets.get('name')
            const version = data.readUInt16BE(name+0)
            const nrecs = data.readUInt16BE(name+2)
            const strings = name + data.readUInt16BE(name+4)
            for (let off = name+6, i = 0; i < nrecs; ++i, off += 12) {
                const splat = data.readUInt16BE(off+0)
                const sspec = data.readUInt16BE(off+2)
                const slang = data.readUInt16BE(off+4)
                const nameid = data.readUInt16BE(off+6)
                const len = data.readUInt16BE(off+8)
                const soff = data.readUInt16BE(off+10)
                const s = decodeString(data.subarray(strings+soff, strings+soff+len), splat, sspec, slang)
                const sn = nameids.get(nameid)
                if (sn && s) {
                    attribs[sn] = s
                }
            }
        }
        if (offsets.has('OS/2')) {
            const table = offsets.get('OS/2')
            const weight = data.readUInt16BE(table+4)
            const width = data.readUInt16BE(table+6)
            attribs['weight'] = weight
            attribs['width'] = width
        }
        return attribs
    }

    function decodeString(s, platform, spec, lang) {
        switch (platform) {
            case 0: return s.toString('utf8')
            case 1:
                if (spec === 0 && lang === 0) {
                    return s.toString('utf8')
                }
                break
            case 3:
                if (spec === 1 && (lang % 256 === 9)) {
                    return s.swap16().toString('utf16le')
                }
        }
    }

    function* glob(root, rx) {
        let fringe = [root]
        while (fringe.length) {
            let dir = fringe.pop()
            let subdirs;
            try {
                subdirs = fs.readdirSync(dir, {withFileTypes:true})
            } catch { continue }
            for (let f of subdirs) {
                if (f.name.match(/^\./)) { continue }
                let fullname = path.join(dir, f.name)
                if (f.isFile() && rx.test(f.name)) {
                    yield fullname
                }
                else if (f.isDirectory()) {
                    fringe.push(fullname)
                }
            }
        }
    }

    function* enumerate_fonts(root) {
        for (let fn of glob(root, /\.(?:ttf|ttc|otf|otc)$/i)) {
            let spec;
            try {
                spec = parse_font_file(fn)
            } catch(e) { console.error(e) }
            if (spec) {
                yield [fn, spec]
            }
        }
    }

    return Object.fromEntries(enumerate_fonts(root))
}

var process = require('process');
let root = '.'
if (process.argv.length > 2) {
    root = process.argv[2]
}
fonts = scanfontsjs(root)

startServer()
