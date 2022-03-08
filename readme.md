Figma local fonts service
==

[![standwithukraine](https://user-images.githubusercontent.com/196601/157243734-2b254bef-f693-4669-9e8e-5a2c8d4e0834.svg)](https://ukrainewar.carrd.co/)

Serves font files from a local directory to Figma web page.

This could be an alternative to [official Figma daemon][DAEMON] which serves all fonts in the system.

[DAEMON]: https://help.figma.com/hc/en-us/articles/360039956894-Access-local-fonts-on-your-computer


Usage
--

### Python
```sh
python serve.py fonts/
```

For WOFF2 support install `brotli` package.

### Node.js
```sh
node serve.js fonts/
```
