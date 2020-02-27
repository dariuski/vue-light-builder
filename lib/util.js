const fs = require('fs')
const path = require('path')
const assert = require('assert')

assert(process.version.match(/v(\d+)/)[1] >= 10, 'Needed node version >=10')

/** @description check if file exists using access
 * @async
 * @param {string} filePath file path
 * @param {Number=} [mode=fs.constants.F_OK] mode checking (fs.constants.*)
 * @returns {Promise<boolean>}
 */
function exists (filePath, mode) {
  return new Promise(resolve => {
    fs.access(filePath, mode || fs.constants.F_OK, err => {
      resolve(!err)
    })
  })
}

/** @description stat file with exists checking
 * @async
 * @param {string} filePath file path
 * @param {Boolean} [allways] exists checking. Resolves null if filePath not exists
 * @returns {Promise<fs.Stats>}
 */
function stat (filePath, allways) {
  var p = function (resolve, reject) {
    fs.stat(filePath, (err, stats) => {
      if (err) reject(err)
      else resolve(stats)
    })
  }
  if (allways)
    return exists(filePath).then(exists =>
      exists ? new Promise(p) : null)
  return new Promise(p)
}

/** @description unlink file
 * @async
 * @param {string} filePath file path
 * @returns {Promise<boolean>}
 */
function unlink (filePath) {
  return new Promise((resolve, reject) => {
    fs.unlink(filePath, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/** @description read directory with iterator
 * @async
 * @param {string} dir directory
 * @param {object} options options recursive: false
 * @param {function} iter iterator
 */
function readdir (dir, options, iter) {
  if (typeof (options) !== 'object') {
    iter = options
    options = {}
  }
  let promise = Promise.resolve()
  const walk = function (subdir, done) {
    fs.readdir(path.resolve(dir, subdir), function (err, list) {
      if (err) return done(err)
      var pending = list.length
      if (!pending) return done()
      list.forEach(file => {
        file = subdir ? subdir + '/' + file : file;
        fs.stat(path.resolve(dir, file), (err, stat) => {
          if (!err && stat) {
            if (options.recursive && stat.isDirectory()) {
              walk(file, () => {
                if (!--pending) done()
              });
              return
            }
            promise = promise.then(() => iter(file, stat))
          }
          if (!--pending) done()
        })
      })
    })
  }
  return new Promise(resolve => {
    walk('', err => {
      if (err)
        promise = promise.then(Promise.reject(err))
      resolve(promise)
    })
  })
}

function _rmfiles (list, pos, parent, callback) {
  if (!list[pos]) return callback()
  list[pos] = path.join(parent, list[pos])
  fs.lstat(list[pos], function (err, stat) {
    if (err) callback(err)
    else if (stat.isDirectory()) {
      fs.readdir(list[pos], function (err, files) {
        if (err) callback(err)
        else _rmfiles(files, 0, list[pos], function (err) {
          if (err) callback(err)
          else fs.rmdir(list[pos], function (err) {
            if (err) callback(err)
            else _rmfiles(list, pos + 1, list[pos], callback)
          })
        })
      })
    } else
      fs.unlink(list[pos], function (err) {
        if (err) callback(err)
        else _rmfiles(list, pos + 1, parent, callback)
      })
  })
}

/** @description remove directory recursively
 * @async
 * @param {string} dir directory path
 */
function rmdir (dir) {
  return new Promise((resolve, reject) => {
    _rmfiles([dir], 0, '', err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/** @description create dir recursively
 * @async
 * @param {string} dir directory path
 * @param {number} [mode=0o777] create mode
 */
function mkdir (dir, mode) {
  return new Promise((resolve, reject) => {
    fs.mkdir(dir, { recursive: true, mode: mode || 0o777 }, err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/*
function _mkdir (dir, mode) {
  mode = mode || 511
  return new Promise(function (resolve, reject) {
    fs.mkdir(dir, mode, err => {
      if (err && err.code !== 'EEXIST') reject(err)
      else resolve(dir)
    })
  })
}

function mkdir (dir, mode) {
  var paths = dir.split(path.sep)
  if (paths[0] === '')
    paths[0] = path.sep
  return paths.reduce((promise, fp) => {
    return promise.then((prev) => {
      fp = path.join(prev, fp)
      return exists(fp).then((exists) => {
        if (!exists)
          return _mkdir(fp, mode)

        return stat(fp).then((stats) => {
          if (stats.isDirectory())
            return fp
          return Promise.reject(new Error('Cannot create directory "' + fp + '"'))
        })
      })
    })
  }, Promise.resolve())
}
*/

/** @description copy file from source to destination
 * @async
 * @param {string} src source path
 * @param {string} dst destination path
 */
function copyFile (src, dst) {
  return new Promise((resolve, reject) => {
    fs.copyFile(src, dst, err => {
      if (err) reject(err)
      else resolve()
    })
  })
}

/** @description copy file/directory from source to destination
 * @async
 * @param {string} src source path
 * @param {string} dst destination path
 */
function copy (src, dst) {
  return mkdir(path.dirname(dst)).then(() =>
    stat(src).then(stats => {
      if (stats.isDirectory())
        return readdir(src, file => copy(path.join(src, file), path.join(dst, file)))
      return copyFile(src, dst)
    })
  )
}

/** @description read file content
 * @async
 * @param {string} path file path
 * @returns {Promise<string>}
 */
function read (path) {
  return new Promise((resolve, reject) => {
    fs.readFile(path, 'utf8', (err, content) => {
      if (err) reject(err)
      else resolve(content)
    })
  })
}

/** @description write to file
 * @async
 * @param {string} dst file path, path will be created using mkdir
 * @param {string|function} content string content or callback: function(writer)
 */
function write (dst, content) {
  if (typeof content !== 'function')
    return mkdir(path.dirname(dst)).then(() =>
      new Promise((resolve, reject) => {
        fs.writeFile(dst, content, 'utf8', err => {
          if (err) reject(err)
          else resolve()
        })
      })
    )
  else
    return mkdir(path.dirname(dst)).then(() => new Promise((resolve, reject) => {
      fs.open(dst, 'w', 0o666, function (err, fd) {
        if (err) reject(err)
        else {
          var writer = function (data) {
            if (!data) {
              return new Promise((resolve, reject) => {
                if (fd) {
                  fs.close(fd, () => {
                    fd = undefined
                    resolve()
                  })
                } else
                  resolve()
              })
            } else {
              return new Promise((resolve, reject) => {
                fs.write(fd, data, function (err) {
                  if (err) reject(err)
                  else resolve()
                })
              })
            }
          }
          var result;
          try {
            result = Promise.resolve(content(writer))
          } catch (err) {
            result = Promise.reject(err)
          }
          result.then(() => {
            writer().then(() => resolve())
          }).catch(err => {
            writer().then(() => reject(err))
          })
        }
      })
    }))
}

/** @description watch direcotory for changes
 * @async
 * @param {string} dir directory/file path
 * @param {function} listener action listener
 * @returns {Promise<function>} unwatch function
 */
function watch (dir, listener) {
  const allFiles = {}
  dir = path.resolve(dir)
  return readdir(dir, { recursive: true }, name => {
    allFiles[name] = true
  }).then(() => {
    const nodeWatch = require('node-watch')

    const fsWatcher = nodeWatch(dir, { recursive: true }, (evt, name) => {
      const stat = evt !== 'remove' ? fs.statSync(name) : null
      name = path.relative(dir, name).replace(/\\/g, '/')
      if (!stat) {
        if (allFiles[name]) {
          delete allFiles[name]
          listener('deleted', name)
        }
      } else {
        if (stat.isFile) {
          if (!allFiles[name]) {
            listener('created', name, stat)
            allFiles[name] = true
          } else {
            listener('changed', name, stat)
          }
        }
      }
    })
    return Promise.resolve(fsWatcher && function () { fsWatcher.close() })
  })
}

/* function watch (dir, listener) {
  const watchers = {}
  function close (path) {
    var watcher = watchers[path]
    if (watcher) {
      delete watchers[path]
      return watcher.close()
    }
  }

  function closeall () {
    for (var file in watchers)
      watchers[file].close()
  }

  function watchFile (filePath) {
    let lastTime
    watchers[filePath] = fs.watch(filePath, function (event, filename) {
      stat(filePath, true).then(stats => {
        if (!stats)
          return close(filePath)
        if ((!lastTime || stats.mtime.getTime() > lastTime)) {
          lastTime = stats.mtime.getTime()
          listener('changed', filePath, stats)
        }
      })
    })
  }

  function watchDir (dir) {
    return readdir(dir, file => {
      const filePath = path.join(dir, file)
      return stat(filePath).then(stats => {
        if (!watchers[filePath]) {
          if (stats.isFile()) {
            listener('created', filePath, stats)
            return watchFile(filePath)
          }
          return watchDir(filePath)
        }
      })
    }).then(() => {
      watchers[dir] = fs.watch(dir, function (event, filename) {
        exists(dir).then(exists => {
          if (exists)
            return watchDir(dir)
          return close(dir)
        }).catch(() => {
          return close(dir)
        })
      })
    })
  }

  return watchDir(dir)
    .then(() => closeall)
    .catch(err => {
      closeall()
      return Promise.reject(err)
    })
} */

/** @description download file content
 * @async
 * @param {string} url url to download
 * @param {string} [filePath] directory/file path
 * @returns {string} filePath or downloaded file content if filePath is not set
 */
function download (url, filePath) {
  return new Promise((resolve, reject) => {
    const http = require(url.startsWith('http:') ? 'http' : 'https')
    http.get(url, response => {
      if (response.statusCode === 200) {
        try {
          if (filePath) {
            const stream = fs.createWriteStream(filePath)
            response.pipe(stream)
            response.on('error', () => {
              unlink(filePath).catch().then(() => { resolve(false) })
            })
            response.on('end', res => {
              resolve(filePath)
            })
          } else {
            let content = ''
            response.on('data', chunk => {
              content += chunk
              if (content.length > 4 * 1024 * 1024)
                throw new Error('Download limit exceeded for url ' + url)
            })
            response.on('error', err => {
              reject(err)
              content = false
            })
            response.on('end', res => {
              if (content !== false)
                resolve(content)
            })
          }
        } catch (err) {
          reject(err)
        }
      } else
        reject(new Error('Status code ' + response.statusCode + ' for ' + url))
    }).on('error', () => {
      reject(new Error('Download error for ' + url))
    })
  })
}

module.exports = {
  exists,
  stat,
  unlink,
  readdir,
  rmdir,
  mkdir,
  copyFile,
  copy,
  read,
  write,
  watch,
  download
}
