/*
MIT License (MIT)

Copyright (c) Darius Kisonas. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE
*/

const http = require('http'),
  querystring = require('querystring'),
  fs = require('fs'),
  path = require('path'),
  crypto = require('crypto')

/** @description output error reponse */
http.ServerResponse.prototype.error = function (code, text) {
  try {
    this.statusCode = code || 200
    this.output(text != null ? text : http.STATUS_CODES[this.statusCode])
  } catch (e) {
  }
}

/** @description output response (sets Content-Type) */
http.ServerResponse.prototype.output = function (data) {
  if (!this.getHeader('Content-Type') && !(data instanceof Buffer)) {
    if (typeof data === 'object') {
      data = JSON.stringify(data)
      this.setHeader('Content-Type', 'application/json')
    } else {
      data = data.toString()
      if (data[0] === '{' || data[1] === '[')
        this.setHeader('Content-Type', 'application/json')
      else if (data[0] === '<')
        this.setHeader('Content-Type', 'text/html')
      else
        this.setHeader('Content-Type', 'text/plain')
    }
  }
  this.setHeader('Content-Length', Buffer.byteLength(data, 'utf8'))
  if (this.headOnly)
    this.end()
  else
    this.end(data)
}

/** @description output json response */
http.ServerResponse.prototype.json = http.ServerResponse.prototype.output

const commonCodes = { 'Not found': 404, 'Access denied': 403, Failed: 422, OK: 200 }

/** @description output json response in form { success: false, error: err } */
http.ServerResponse.prototype.jsonError = function (err, code) {
  if (typeof err === 'object' && typeof err.message !== 'undefined') {
    console.error(err.stack || err)
    // if (err instanceof mongoose.Error.ValidationError ||
    //  err instanceof mongoose.Error.CastError)
    //  code = code || 422
    code = code || err.statusCode || 500
    err = err.message
  }
  this.statusCode = code || commonCodes[err] || 422
  this.json({ success: false, error: err })
}

/** @description output json response in form { success: true, ... } */
http.ServerResponse.prototype.jsonSuccess = function (obj, code) {
  if (typeof obj === 'object') {
    obj = Object.assign({ success: true }, obj)
  } else {
    if (typeof obj === 'string')
      obj = { success: true, message: obj }
    else
      obj = { success: true }
  }
  this.statusCode = code || 200
  this.json(obj)
}

/** @description output json response in form { success: true, data: obj } */
http.ServerResponse.prototype.jsonData = function (obj, name) {
  this.statusCode = 200
  const res = { success: true }
  res[name || 'data'] = obj
  this.json(res)
}

const server = {}

/** @description router middleware
 * returns middleware with methods:
 *    clear()
 *    add(method|'*', url, cb, ...)
 *    hook(method|'*', url, cb, ...)
 *    GET(url, cb, ...) => add('GET', url, cb, ...)
 *    POST(url, cb, ...) => add('POST', url, cb, ...)
 *    PUT(url, cb, ...) => add('PUT', url, cb, ...)
 *    DELETE(url, cb, ...) => add('DELETE', url, cb, ...)
 * url format:
 *    /path/:param/subpath/:lastparam*
 * @returns {Function} middleware
 */
server.router = function () {
  let tree = {}
  function doItem (item, req, res, next) {
    req.params = {}
    const rstack = []
    req.pathname.replace(/\/([^/]*)/g, (_, name) => {
      if (item) {
        if (!item.tree) { // last
          req.params[item.name] += '/' + name
        } else {
          item = item.tree[name] || item.param || item.last
          if (item && item.name)
            req.params[item.name] = name
          if (item && item.hook)
            item.hook.forEach(i => rstack.push(i))
        }
      }
    })
    if (item && item.next)
      item.next.forEach(i => rstack.push(i))
    if (!rstack.length)
      return;
    let rnexti = 0
    const rnext = function () {
      const cb = rstack[rnexti++]
      if (cb) {
        try {
          const p = cb(req, res, rnext)
          if (p instanceof Promise)
            p.catch(e => {
              console.error(e.stack || e)
              res.error(500)
            })
        } catch (e) {
          console.error(e.stack || e)
          res.error(500)
        }
      }
    }
    rstack.push(next)
    rnext()
    return true;
  }
  const middleware = function (req, res, next) {
    if (!doItem(tree[req.method], req, res, next) && !doItem(tree['*'], req, res, next))
      next()
  }
  const addItem = function (method, url, key, values) {
    let item = tree[method]
    if (!item)
      item = tree[method] = { tree: {} }
    url.replace(/\/(:?)([^/*]+)(\*?)/g, (_, param, name, last) => {
      if (last) {
        item.last = { name: name }
        item = item.last
      } else {
        if (!item.tree)
          throw new Error('Invalid route path')
        if (param) {
          item = item.param = { tree: {}, name: name }
        } else {
          let subitem = item.tree[name]
          if (!subitem)
            subitem = item.tree[name] = { tree: {} }
          item = subitem
        }
      }
    })
    if (!item[key])
      item[key] = []
    values.forEach(i => item[key].push(i))
    return item
  }

  middleware.clear = function () {
    tree = {}
    return middleware
  }
  middleware.add = function (method, url, ...args) {
    addItem(method, url, 'next', args)
    return middleware
  }
  middleware.hook = function (method, url, ...args) {
    addItem(method, url, 'hook', args)
    return middleware
  }
  middleware.GET = middleware.add.bind(this, 'GET')
  middleware.POST = middleware.add.bind(this, 'POST')
  middleware.PUT = middleware.add.bind(this, 'PUT')
  middleware.DELETE = middleware.add.bind(this, 'DELETE')

  return middleware
}

/** @description virtual host middleware
 * returns middleware with methods:
 *    get(host)
 *    add(hosts, cb|default=router())
 *    clear()
 * @returns {Function} middleware
 */
server.vhost = function () {
  let list = {}
  const middleware = function (req, res, next) {
    const item = list[req.headers.host]
    return item ? item(req, res, next) : next()
  }
  middleware.clear = function () {
    list = {}
    return middleware
  }
  middleware.add = function (hosts, cb) {
    if (!Array.isArray(hosts))
      hosts = [hosts]
    cb = cb || server.router()
    hosts.forEach(name => {
      list[name] = cb
    })
    return cb
  }
  middleware.get = function (host) {
    return list[host]
  }
  return middleware
}

/** @description OPTIONS method middleware
 * @param {object} validMethods object of methods {method: true}
 * @returns {Function} middleware
 */
server.options = function (validMethods) {
  return function (req, res, next) {
    if (!validMethods[req.method])
      return res.error(400)

    if (req.method === 'HEAD') {
      req.method = 'GET'
      res.headOnly = true
    } else if (req.method === 'OPTIONS') {
      res.statusCode = 204
      const allow = []
      for (const n in validMethods)
        allow.push(n);
      res.setHeader('Allow', allow.join(', '))
      res.end()
    } else
      next()
  }
}

/** @description Cors middleware
 * @param {object} options cors options
 * @param {string} options.cors value for Access-Control-Allow-Origin
 * @returns {Function} middleware
 */
server.cors = function (options) {
  return function (req, res, next) {
    if (options.cors && req.headers.origin) {
      if (typeof options.cors === 'string' && options.cors !== '*') {
        res.setHeader('Access-Control-Allow-Origin', options.cors)
        return next()
      }
      res.setHeader('Access-Control-Allow-Origin', '*')
      if (req.headers.origin === 'null' && req.localip)
        res.setHeader('Access-Control-Allow-Origin', 'null')
    }
    next()
  }
}

/** @description Local IP middleware
 * @param {object} options local ip detection options
 * @param {string} options.trustProxy trust 'x-real-ip' header value
 * @returns {Function} middleware
 */
server.localip = function (options) {
  return function (req, res, next) {
    req.ip = res.socket.remoteAddress
    const xip = req.headers['x-real-ip']
    req.localip = !!req.ip.match(/^(127\.|10\.|192\.168\.|fe80|fc|fd|::)/) && (!xip || !!xip.match(/^(127\.|10\.|192\.168\.|fe80|fc|fd|::)/))
    if (options.trustProxy && xip)
      req.ip = xip
    next()
  }
}

/** @description Not found middleware
 */
server.notfound = function (req, res) {
  res.error(404, '404 Not found')
}

/** @description Body middleware
 * @returns {Function} middleware
 */
server.body = function () {
  return function (req, res, next) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    req.path = req.url
    req.pathname = parsedUrl.pathname
    const get = {}
    parsedUrl.searchParams.forEach((v, k) => {
      get[k] = v
    })
    req.get = get

    if (req.body) {
      req.rawBody = req.body
      const contentType = req.headers['Content-Type'] || ''
      const ch = req.body[0]
      if (ch === '{' || ch === '[') {
        try {
          req.body = JSON.parse(req.body)
        } catch (ex) {
          res.error(400)
          return
        }
      } else if (contentType.startsWith('application/x-www-form-urlencoded')) {
        req.body = querystring.parse(req.body)
      } else {
        req.body = {}
      }
    } else
      req.body = {}
    req.post = req.body
    next()
  }
}

// predefined mime types
const mimeTypes = {
  '.ico': 'image/x-icon',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf'
};
server.mimeTypes = mimeTypes
const etagPre = crypto.randomBytes(4).toString('hex')

/** @description Static files middleware
 * @param {object} options static files serve options
 * @param {string} options.root files root directrory
 * @param {string} options.ignore list of ignore subpath
 * @returns {Function} middleware for static files
 */
server.files = function (root, options) {
  options = options || {}
  root = path.normalize(root) + path.sep
  const ignore = [];

  (Array.isArray(options.ignore) ? options.ignore : [options.ignore]).forEach(n => {
    if (n)
      ignore.push(path.normalize(path.join(root, n)) + path.sep)
  })
  return function (req, res, next) {
    if (req.method !== 'GET')
      next();

    var filename = path.normalize(path.join(root, (req.params && req.params.path) || req.pathname));
    if (!filename.startsWith(root)) // check root access
      return next();

    if (filename.endsWith(path.sep))
      filename += 'index.html'

    const mimeType = mimeTypes[path.extname(filename)]
    if (!mimeType)
      return next();

    // check ignore access
    for (let i = 0; i < ignore.length; i++) {
      if (filename.startsWith(ignore[i]))
        return next();
    }

    req.filename = filename
    function process () {
      fs.stat(req.filename, function (err, stats) {
        if (err || stats.isDirectory())
          return next()

        const etagMatch = req.headers['if-none-match']
        const etagTime = req.headers['if-modified-since']
        const etag = '"' + etagPre + stats.mtime.getTime().toString(32) + '"'

        res.setHeader('Content-Type', mimeType)
        if (options.lastModified !== false)
          res.setHeader('Last-Modified', stats.mtime.toUTCString())
        if (options.etag !== false)
          res.setHeader('Etag', etag)
        if (options.maxAge != null)
          res.setHeader('Cache-Control', 'max-age=' + options.maxAge)

        if (res.headOnly) {
          res.setHeader('Content-Length', stats.size)
          return res.end()
        }

        if (etagMatch === etag || etagTime === stats.mtime.toUTCString()) {
          res.statusCode = 304
          return res.end()
        }

        res.setHeader('Content-Length', stats.size)
        var readStream = fs.createReadStream(req.filename);
        readStream.pipe(res);
      });
    }

    if (options.hook)
      options.hook(req, res, process)
    else
      process()
  }
}

const validHeaders = {
  Authorization: true,
  Accept: true,
  'Accept-Encoding': true,
  'Accept-Language': true,
  'Cache-Control': true,
  Cookie: true,
  'Content-Type': true,
  'Content-Length': true,
  Host: true,
  Referer: true,
  'If-Match': true,
  'If-None-Match': true,
  'If-Modified-Since': true,
  'User-Agent': true,
  Date: true
}
server.validHeaders = validHeaders

/** @description Proxy middleware
 * @param {object} options proxy options
 * @param {string} options.url url prefix for destination
 * @param {string} options.match regex match for url (optional)
 * @returns {Function} middleware
 */
server.proxy = function (options) {
  if (typeof options === 'string')
    options = { url: options }
  const url = new URL(options.url)
  const http = require('http'), https = require('https')
  const match = options.match && new RegExp(options.match)

  return (req, res) => {
    const reqOptions = { method: req.method, headers: {}, host: url.hostname, port: url.port, path: url.pathname }, rawHeaders = req.rawHeaders
    let path = req.params.path
    if (path)
      path += (req.path.match(/\?.*/) || [''])[0]
    if (!path && match) {
      path = match(req.path)
      if (!path) {
        res.statusCode = '400'
        res.end('Error 400')
        return
      }
      path = path.length > 1 ? path[1] : path[0]
    }
    if (!path)
      path = req.path
    if (path && path[0] !== '/')
      path = '/' + path
    reqOptions.path += path
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const n = rawHeaders[i]
      if (validHeaders[n] && n !== 'Host')
        reqOptions.headers[n] = rawHeaders[i + 1]
    }
    if (options.headers)
      Object.assign(reqOptions.headers, options.headers)
    if (!options.headers.Host)
      options.headers.Host = url.hostname
    const conn = url.protocol === 'https:' ? https.request(options) : http.request(options)
    conn.on('response', response => {
      res.statusCode = response.statusCode
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        const n = response.rawHeaders[i]
        if (n !== 'Transfer-Encoding' && n !== 'Connection')
          res.setHeader(n, res.rawHeaders[i + 1])
      }
      response.on('data', chunk => {
        res.write(chunk)
      })
      response.on('end', () => {
        res.end()
      })
    })
    conn.on('error', () => {
      res.statusCode = 502
      res.end('Error 502')
    })
    if (req.rawBody)
      conn.write(req.rawBody)
    conn.end()
  }
}

/** @description Http request application
 * @param {object} options http app options
 * @returns {Function}
 */
server.createApp = function (options) {
  const stack = []
  const app = function (req, res) {
    req.res = res

    // limit input data size
    if (parseInt(req.headers['content-length'] || 0) > 1024 * 1024) {
      res.error(400);
      req.close()
      return
    }

    let body = []
    req.on('error', (err) => {
      console.error(err);
    }).on('data', (chunk) => {
      body.push(chunk)
    }).on('end', err => {
      if (err) return;
      if (body.length) {
        const contentType = req.headers['Content-Type'] || ''
        const charset = contentType.match(/charset=(\S+)/)
        req.body = Buffer.concat(body).toString(req.contentType.indexOf(charset ? charset[1] : 'utf8'))
      }
      body = undefined
      res.statusCode = 200

      let nextIndex = 0;
      const next = function next () {
        const f = stack[nextIndex++]
        if (f) {
          const p = f(req, res, next)
          if (p instanceof Promise)
            p.catch(e => {
              console.error(e.stack || e)
              res.error(500)
            })
        } else
          server.notfound(req, res)
      }
      next()
    })
  }

  app.stack = stack
  app.options = options
  app.vhost = server.vhost(options)
  app.router = server.router(options)
  app.use = function (cb) {
    if (typeof cb === 'string') {
      app.router.add.bind(null, '*').apply(null, arguments)
      cb = app.router
    }
    if (stack.indexOf(cb) < 0)
      stack.push(cb)
    return app
  }

  let wslist
  app.handleUpgrade = function (req, socket, head) {
    const wss = wslist && wslist[req.url],
      end = () => { socket.destroy() },
      next = () => {
        wss.handleUpgrade(req, socket, head, function done (ws) {
          wss.emit('connection', ws, req);
        });
      }
    if (!wss)
      return end()
    if (options.hook)
      return options.hook(req, { end: end, write: end, setHeader: end }, next)
    return next()
  }
  app.websocket = function (url, cb) {
    if (!wslist)
      wslist = {}
    const wss = new (require('ws').Server)({ noServer: true })
    wss.on('connection', cb)
    wslist[url] = wss
    return app
  }
  app.static = function (url, dir, options) {
    if (url[0] !== '/')
      url = '/' + url
    if (!url.endsWith('/'))
      url += '/'
    app.router.GET(url + ':path*', server.files(dir || ('.' + url), options))
    return app.use(app.router)
  }
  app.proxy = function (url, remoteurl) {
    if (!url.endsWith('/'))
      url += '/'
    return app.use(url + ':path*', server.proxy(remoteurl))
  }

  // fill stack with required middlewares
  let validMethods = { OPTIONS: 1, GET: 1, POST: 1, PUT: 1, DELETE: 1 }
  if (options.methods) {
    validMethods = { OPTIONS: 1 }
    const methods = typeof options.methods === 'string' ? options.methods.split(',') : options.methods
    methods.forEach(m => { validMethods[m] = 1 })
  }
  if (validMethods.OPTIONS)
    app.use(server.options(validMethods))
  app.use(server.localip(options))
  if (options.cors)
    app.use(server.cors(options))
  app.use(server.body(options))

  return app
}

/** @description Create http server
 * returns:
 *    server.app:serverApp
 *    server.mimeTypes:{[extname: string]= string}
 *    server.use(middleware)
 *    server.use(url, middleware)
 *    server.router.clear()
 *    server.router.add(method, url, middleware)
 *    server.router.hook(method, url, middleware)
 *    server.router.GET(url, middleware)
 *    server.router.POST(url, middleware)
 *    server.router.PUT(url, middleware)
 *    server.router.DELETE(url, middleware)
 *      url in form:
 *        /path/:param/subpath/:lastparam*
 *    server.GET(url, middleware)
 *    server.POST(url, middleware)
 *    server.PUT(url, middleware)
 *    server.DELETE(url, middleware)
 *    server.vhost.clear()
 *    server.vhost.add('vhost'):router
 *    server.vhost.add('vhost', middleware)
 *    server.vhost.add(['vhost1','vhost2']):router
 *    server.static(url, root, options)
 *    server.proxy(url, remoteurl, options)
 *    server.websocket(url, cb)
 * @param {object} options server options
 * @param {string} options.hostname bind host (default: 'localhost')
 * @param {string|number} options.port bind port (default: 8080)
 * @param {function} options.app function(req,res) (default: createApp(options))
 * @param {string|boolean} options.cors '*'|'...'|true|false (default: false)
 * @param {boolean} options.trustProxy true|false (default: false)
 * @param {array} options.methods ['GET','POST','HEAD',....] (default: ['GET','POST,'PUT','DELETE'])
 * @param {function} options.hook: function(req,res,next) (default: null)
 * @returns {Function} middleware
 */
server.server = function (options) {
  let app = options.app
  if (!app) {
    app = server.createApp(options)
    if (typeof options.hook === 'function')
      app.use(options.hook)
    app.use(app.vhost)
    app.use(app.router)
  }

  const httpServer = http.createServer(app)

  const port = options.port || 8080, hostname = options.hostname || 'localhost'
  httpServer.listen(port, hostname, () => {
    httpServer.emit('listen', port, hostname)
  })
  httpServer.on('error', () => {
    setTimeout(() => { httpServer.close() }, 100)
  })
  if (app.use) {
    'use,vhost,router,static,websocket,proxy'.split(',').forEach(n => { httpServer[n] = app[n] })
    'GET,POST,PUT,DELETE'.split(',').forEach(n => { httpServer[n] = app.router[n] })
    httpServer.on('upgrade', app.handleUpgrade)
  }
  httpServer.app = app
  return httpServer
}

module.exports = server
