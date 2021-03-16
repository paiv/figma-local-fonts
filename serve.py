#!/usr/bin/env python
import http.server
import json
import re
import socketserver
import struct
import sys
import traceback
from pathlib import Path
from urllib.parse import urlsplit, parse_qs


VERSION = 17
BIND_PORT = 18412
FONTS = None


class RequestHandler (http.server.BaseHTTPRequestHandler):

    def _accept_json(self, obj):
        s = json.dumps(obj, separators=',:').encode('utf-8')
        self._accept(s, 'application/json')

    def _accept_binary(self, data):
        self._accept(data, 'application/octet-stream')

    def _accept(self, data, content_type):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def _ignore(self, comment):
        print(f'ignoring: {comment}', file=sys.stderr)
        self.send_response(404)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()

    def do_GET(self):
        _,_,path,query,_ = urlsplit(self.path)

        if path == '/figma/version':
            self._accept_json({'version': VERSION})

        elif path == '/figma/font-files':
            self._accept_json({'version': VERSION, 'fontFiles': FONTS})

        elif path == '/figma/update':
            params = parse_qs(query)
            ver = params.get('version')
            if ver is None:
                self._ignore('missing version')
            else:
                try:
                    ver, = ver
                    v = float(ver)
                    if v > VERSION:
                        print('CHECK FOR UPDATES', file=sys.stderr)
                    self._accept_json({'version': VERSION})
                except (TypeError, ValueError):
                    self._ignore(f'invalid version: {ver}')

        elif path == '/figma/font-file':
            params = parse_qs(query)
            file = params.get('file')
            if file is None:
                self._ignore('missing file')
            try:
                file, = file
                if file in FONTS:
                    with open(file, 'rb') as fp:
                        data = fp.read()
                    self._accept_binary(data)
                    return
            except:
                print(repr(file), file=sys.stderr)
                traceback.print_exc()
            self._ignore(f'invalid file: {file}')

        else:
            self._ignore(f'invalid url: {self.path}')


def parse_font_file(fn):
    with open(fn, 'rb') as fp:
        data = fp.read()
    sig, = struct.unpack('>I', data[:4])
    if sig == 0x74746366:
        spec = analyze_font_collection(data)
    else:
        spec = [analyze_font(data)]
    return spec


def analyze_font_collection(data):
    major, minor, nfonts = struct.unpack('>HHI', data[4:12])
    if not ((major == 1 or major == 2) and (minor == 0)):
        raise Exception(f'Unsupported format version {(major, minor)}')
    def inner(data, i):
        off = 12 + i * 4
        p, = struct.unpack('>I', data[off:off+4])
        return analyze_font(data, p)
    return [inner(data, i) for i in range(nfonts)]


def analyze_font(data, table_offset=0):
    off = table_offset + 0
    sig, ntables = struct.unpack('>IH', data[off:off+6])
    if  sig != 0x4F54544F: # OTTO
        major, minor = struct.unpack('>HH', data[off:off+4])
        if not ((major == 1) and (minor == 0)):
            raise Exception(f'Unsupported format version {(major, minor)}')

    offsets = dict()
    for i in range(ntables):
        off = table_offset + 12 + i * 16
        p, = struct.unpack('>I', data[off+8:off+12])
        tag = data[off:off+4].decode('utf-8')
        offsets[tag] = p

    off = offsets['head']
    major, minor = struct.unpack('>HH', data[off:off+4])
    if not ((major == 1) and (minor == 0)):
        raise Exception(f'Unsupported format version {(major, minor)}')

    sig, = struct.unpack('>I', data[off+12:off+16])
    if sig != 0x5F0F3CF5:
        raise Exception(f'Invalid signature {sig:08X}')

    mac_style, = struct.unpack('>H', data[off+44:off+46])
    italic = (mac_style & 2) != 0
    attribs = dict(italic=italic)

    nameids = {1: 'family', 2: 'style', 6: 'postscript'}
    name = offsets['name']
    version, nrecs, table = struct.unpack('>HHH', data[name:name+6])
    for i in range(nrecs):
        off = name + 6 + i * 12
        splat, sspec, slang, nameid, slen, soff = struct.unpack('>HHHHHH', data[off:off+12])
        soff += name + table
        sn = nameids.get(nameid)
        if sn:
            s = decode_string(data[soff:soff+slen], splat, sspec, slang)
            if s:
                attribs[sn] = s

    off = offsets.get('OS/2')
    if off:
        weight, width = struct.unpack('>HH', data[off+4:off+8])
        attribs['weight'] = weight
        attribs['width'] = width

    return attribs


def decode_string(s, platform, spec, lang):
    if platform == 0:
        return s.decode('utf-8')
    elif platform == 1:
        if spec == 0 and lang == 0:
            return s.decode('utf-8')
    elif platform == 3:
        if spec == 1 and (lang % 256) == 9:
            return s.decode('utf-16be')


def scan_fonts(roots):
    def glob(roots, rx):
        fringe = [Path(s) for s in roots]
        while fringe:
            d = fringe.pop()
            for fn in d.iterdir():
                if fn.name.startswith('.'): continue
                if fn.is_file() and rx.search(fn.name):
                    yield fn
                elif fn.is_dir():
                    fringe.append(fn)

    def enumerate_fonts(roots):
        rx = re.compile(r'\.(ttf|ttc|otf|otc)$', re.I)
        for fn in glob(roots, rx):
            try:
                spec = parse_font_file(fn)
                yield [str(fn), spec]
            except:
                print(fn, file=sys.stderr)
                traceback.print_exc()

    return dict(enumerate_fonts(roots))


def start_server():
    with socketserver.TCPServer(('localhost', BIND_PORT), RequestHandler) as httpd:
        print('starting server')
        httpd.serve_forever()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Serve local fonts to Figma.')
    parser.add_argument('roots', metavar='dir', nargs='*', default=['.'], help='a directory with font files')
    args = parser.parse_args()

    FONTS = scan_fonts(args.roots)
    start_server()
