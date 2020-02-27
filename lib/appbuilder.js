const fs = require('fs')
const util = require('./util')
const path = require('path')
const assert = require('assert')
const events = require('events')

const noop = () => { }

// TODO: liveReload .template support
// TODO: liveReload vue component proxy, for automatic reload
// TODO: liveReload file delete
// TODO: liveReload vue component reload on change of external dependencies
// TODO: liveReload track dependecies on file change (remove/add)

function parseArgs (args, multiple) {
  if (Array.isArray(args)) {
    const options = {}
    args.forEach(arg => {
      let param = arg.match(/^--?([a-zA-Z][^=]+)(=(.*))?/)
      if (param) {
        if (param[2])
          options[param[1]] = param[3]
        else {
          param = param[1].match(/^(no-?)?(.+)/)
          if (param)
            options[param[2]] = !param[1]
        }
      }
    })
    return options
  }
  return args
}

const compilerExtension = {
  script: 'js',
  style: 'css',
  template: 'template',
  html: 'html'
}

/*
Content compilers

options:
  compiler - reference to compiler object
  builder - reference to builder
  data - input data content
  fileInfo - file info object
    inputPath - relative input path
    name - internal name
    outputPath - relative output path
    url - if file was downloaded

Returns object:
  errors - array of errors (optional)
  warnings - array of warnings (optional)
  style - generated css content with auto naming (optional)
  sript - generated script content with auto naming (optional)
  html - generated html content with auto naming (optional)
  template - generated template content with auto naming, integrated into html (optional)

Some of builder functions
  builder.require(name, options.fileInfo)
  builder.require({name: itemName, outputPath: outputPath}, options.fileInfo)
  builder.compile(compilerName, options)
 */
var compilers = {
  css: {
    style: true
  },
  sass: {
    style: true,
    compile: async function (options) {
      const sass = require('sass')
      const { css } = sass.renderSync({ data: options.data, includePaths: [path.dirname(options.fileInfo.inputPath)] })
      return {
        style: css.toString()
      }
    }
  },
  scss: {
    style: true,
    compile: async function (options) {
      const sass = require('sass')
      const { css } = sass.renderSync({ data: options.data, includePaths: [path.dirname(options.fileInfo.inputPath)] })
      return {
        style: css.toString()
      }
    }
  },
  vue: {
    script: true,
    style: true,
    compile: async function (options) {
      const vueCompiler = require('vue-template-compiler')
      const obj = vueCompiler.parseComponent(options.data)
      let template, script = '', styles = ''
      if (obj.template && obj.template.content) {
        template = vueCompiler.compile(obj.template.content, {
          preserveWhitespace: false
        })
        if (template.errors.length) {
          throw new Error('Vue template error in ' + options.fileInfo.name + ': ' + template.errors[0])
        }
      }
      if (obj.script && obj.script.content) {
        script = ''
        if (template && template.render) {
          script = ';module.exports.render=function(){/** @suppress {with} */' + template.render + '}'
          if (template.staticRenderFns.length)
            script += ';module.exports.staticRenderFns=[function(){/** @suppress {with} */' + template.staticRenderFns.join('},function(){/** @suppress {with} */') + '}]'
        }
        script = (await this.compilers.js.compile({ data: obj.script.content + script, fileInfo: options.fileInfo })).script
      }
      if (obj.styles && obj.styles.length) {
        styles = []
        for (let i = 0; i < obj.styles.length; i++) {
          const style = obj.styles[i]
          const compiler = this.compilers[(style.attrs && style.attrs.type) || 'css']
          if (!compiler || !compiler.style)
            throw new Error('Style type=' + ((style.attrs || {}).type || 'css') + ' not supported in ' + options.fileInfo.name)
          if (!compiler.compile)
            styles.push(style.content)
          else {
            const res = await compiler.compile({ data: style.content, fileInfo: options.fileInfo })
            if (res.style || res.css)
              styles.push(res.style || res.css)
          }
          styles = styles.join('\n')
        }
      }

      return {
        script: script,
        style: styles
      }
    }
  },
  json: {
    script: true,
    compile: async function (options) {
      return {
        script: 'module.exports=' + options.data
      }
    }
  },
  js: {
    script: true,
    declare: function (name, content) {
      return this.options.requireName + '(' + (isNaN(name) ? '\'' + name + '\'' : name) + ',function(module,exports,require){' + content + '})'
    },
    require: function (name) {
      return 'require' + (isNaN(name) ? ('(\'' + name + '\')') : ('(' + name + ')'))
    },
    compile: async function (options) {
      const parsed = []
      let lastPos = 0
      let relativePath = options.fileInfo.inputPath.match(/^(.*)\/[^/]+$/)
      relativePath = relativePath && relativePath[1]

      /* interpret:
        import(mod) => require(mod)
        ... from import(mod) => ... = require(mod)
        { name as Name } => { name: Name }
        * as name => name
      */

      options.data.replace(/\/\*([\s\S]*?)\*\/|\/\/([^\r\n]*)|("(?:[^"\\]*(?:\\.[^"\\]*)*)"|'(?:[^'\\]*(?:\\.[^'\\]*)*)')|import\s+(([^'"]+)\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|([\w_$*]+)\s+as\s+([\w_$]+)/g, (_, comment1, comment2, str, _f, vars, name, reqname, varname, varrename, pos) => {
        if (comment1 != null || comment2 != null) // comment may be empty string
          return

        parsed.push(options.data.substr(lastPos, pos - lastPos))
        lastPos = pos + _.length

        if (str) { // string value
          parsed.push(str)
          return
        }
        if (varname) { // varname as varrename
          parsed.push((varname === '*' ? '' : varname + ': ') + varrename)
          return
        }
        if (vars) // import vars from ...
          vars = vars.replace(/([\w_$*]+)\s+as\s+([\w_$]+)/g, (_, n, v) => (n === '*' ? '' : n + ': ') + v)

        name = name || reqname
        const fileInfo = { name: name, ext: path.extname(name).substr(1) }
        if (name.substr(0, 2) === './' && relativePath)
          name = relativePath + name.substr(1)
        else if (name.substr(0, 2) === '~/' || name.substr(0, 2) === './') {
          name = name.substr(2)
        } else if (name.match(/^https?:\/\/.+$/)) {
          fileInfo.url = name
          fileInfo.vendor = true
        } else if (name.match(/^[^./]+$/)) {
          fileInfo.vendor = true
          fileInfo.inputPath = name + '.js'
        }
        fileInfo.name = name
        if (!fileInfo.inputPath)
          fileInfo.inputPath = name
        this.updateFileInfo(fileInfo)
        parsed.push({ fileInfo: fileInfo, vars: vars })
      })
      parsed.push(options.data.substr(lastPos))

      for (let i = 0; i < parsed.length; i++) {
        if (typeof (parsed[i]) === 'object') {
          const { fileInfo, vars } = parsed[i];
          await this.require(fileInfo, options.fileInfo)
            .then(requireFileInfo => {
              parsed[i] = (vars ? 'const ' + vars + ' = ' : '') + this.compilers.js.require(requireFileInfo.name)
              // skip css files require
              if (path.extname(requireFileInfo.outputPath) === '.css')
                parsed[i] = '// ' + parsed[i]
            })
        }
      }
      let content = parsed.join('')
      content = content.replace(/([\r\n]+|^)\s*export\s+(function\s+)?(\S+)\s*/g, (_, c, f, n) =>
        c + 'module.exports' + (n !== 'default' ? '.' + n : '') + '=' + (f ? f + n : ''))
      return { script: content }
    }
  },
  html: {
    html: true,
    preBuild: '',
    postBuild: '',
    liveReload: '',
    compile: async function (options) {
      const jsPath = options.fileInfo.inputPath.substr(0, options.fileInfo.inputPath.lastIndexOf('.') + 1) + 'js';
      if (await this.statInput(jsPath)) {
        const requireFileInfo = await this.require(jsPath, options.fileInfo)
        const files = this.dependencyList(requireFileInfo.outputPath)

        // generate all css
        let includePos = options.data.indexOf('</head>')
        if (includePos < 0)
          throw new Error('Html head not found')
        else {
          const pos = options.data.lastIndexOf('</script>', includePos)
          if (pos > 0)
            includePos = pos + 9
        }
        const links = []
        links.push('')
        links.push('<script>' + options.compiler.preBuild.replace(/\$req/g, this.options.requireName).replace(/\{1\}/g, requireFileInfo.name) + '</script>')
        if (this.options.live && options.compiler.liveReload)
          links.push('<script>(' + options.compiler.liveReload.replace(/\$req/g, this.options.requireName) + ')()</script>')
        for (let index = 0; index < files.length; index++) {
          const fileInfo = files[index]
          const ext = path.extname(fileInfo.outputPath).substr(1)
          if (ext === 'css')
            links.push('<link rel="stylesheet" href="' + fileInfo.outputPath /* + '?' + fileInfo.time */ + '">')
          if (ext === 'js')
            links.push('<script src="' + fileInfo.outputPath /* + '?' + fileInfo.time */ + '"></script>')
          if (ext === 'template') {
            links.push(await this.readOutput(fileInfo))
          }
        }
        if (options.compiler.postBuild)
          links.push('<script>' + options.compiler.postBuild.replace(/\$req/g, this.options.requireName).replace(/\{1\}/g, requireFileInfo.name) + '</script>')
        links.push('')

        return {
          html: options.data.substr(0, includePos) + links.join('\n  ') + options.data.substr(includePos)
        }
      } else {
        return {
          html: options.data
        }
      }
    }
  }
}

// ============================================================================
// Client side Live-Reload
/* eslint-disable no-undef,no-unused-vars */
const liveReloadClient = function () {
  function hash (str) {
    var i, l, hval = 0x811c9dc5;
    for (i = 0, l = str.length; i < l; i++) {
      hval ^= str.charCodeAt(i);
      hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
    }
    return hval >>> 0;
  }

  $req.vm = {};
  var mixin = {
    beforeCreate: function () {
      $req.vm[this._uid] = this;
    },
    beforeDestroy: function () {
      delete $req.vm[this._uid];
    }
  };
  $req.h = function (n, f, m, cur, prev) { // hook
    if (m.name === 'Vue')
      m.mixin(mixin);
    const isComponent = m.render;
    let reload = !!prev;
    if (isComponent) {
      var hashContent = f.toString()
      var posRender = hashContent.indexOf('exports.render=');
      if (posRender >= 0)
        hashContent = hashContent.substr(0, posRender);
      hashContent = hash(hashContent);
      reload = prev && prev._hash !== hashContent;
      cur._hash = hashContent;

      // component render proxy
      cur._render = m.render;
      cur._staticRenderFns = m.staticRenderFns;
      cur._staticTrees = []
      m.render = function () {
        var mod = $req.c[n] || cur
        if (mod._staticRenderFns) { // only
          this._staticTrees = mod._staticTrees
          this.$options.staticRenderFns = mod._staticRenderFns
        }
        if (mod._render)
          return mod._render.apply(this, arguments)
        console.error('Invalid component ' + n)
      }

      // TODO: add functional component proxy for full component reload
      // rerender all components, as functional components has no own vm
      if (!reload && prev && prev._render) {
        for (var id in $req.vm)
          $req.vm[id].$forceUpdate()
      }
    }

    if (reload) {
      console.log('Module ' + n + ' updated');
      location.reload()
    }
  }

  var opened = -1, lr;
  function openLR () {
    lr = new WebSocket('ws://' + location.host + '/livereload')
    lr.onopen = function () { if (!opened) location.reload(); else opened = 1 }
    lr.onclose = function () { opened = 0; setTimeout(openLR, 2000) }
    lr.onmessage = function (msg) {
      msg = JSON.parse(msg.data);
      var ext = msg.path.match(/[^./]*$/)[0], hash = ''; // '?' + Math.ceil(new Date() / 1000);
      if (ext === 'css' || ext === 'js') {
        var updated;
        document.querySelectorAll(ext === 'css' ? 'link' : 'script')
          .forEach(function (el) {
            // console.log([msg.path, el.getAttribute('href'), el.getAttribute('src'), el])
            if ((el.getAttribute('href') || '').startsWith(msg.path)) {
              el.href = msg.path + hash;
              updated = true;
            }
            if ((el.getAttribute('src') || '').startsWith(msg.path))
              el.parentNode.removeChild(el);
          });
        if (!updated) {
          var parent = document.querySelector('head') || document.querySelector('body'), el;
          el = document.createElement(ext === 'css' ? 'link' : 'script');
          if (ext === 'css') {
            el.rel = 'stylesheet';
            el.href = msg.path + hash;
          } else
            el.src = msg.path + hash;
          parent.appendChild(el);
        }
      }
    }
  }
  openLR()
}

function requireClient () {
  function $req (n, f) {
    var cb = $req.c[n], cbNew;
    if (!f) {
      if (!cb)
        throw new Error('Module \'' + n + '\' not found');
      return cb()
    }
    // declare module loader
    cbNew = function () {
      var m = { exports: {} };
      f(m, m.exports, $req);
      var prev = $req.c[n], cur;
      m = m.exports;
      $req.c[n] = cur = function () { return m }
      cur.ready = true
      if (m && $req.h)
        $req.h(n, f, m, cur, prev.ready && prev)
      return m;
    }
    if (cb && cb.ready)
      cbNew()
    else
      $req.c[n] = cbNew
  }
  $req.c = {};
  document.addEventListener('DOMContentLoaded', function () { $req('{1}') })
}
/* eslint-enable no-undef,no-unused-vars */

compilers.html.liveReload = liveReloadClient.toString()

compilers.html.preBuild = requireClient.toString().match(/\{([\s\S]+)\}/)[1]
// ============================================================================

var builders = {
  developer: {
  },
  production: {
    updateFileInfo: function (fileInfo) {
      if (fileInfo.url) {
        const crypto = require('crypto')
        const md5sum = crypto.createHash('md5')
        md5sum.update(fileInfo.name)

        const ext = fileInfo.ext
        fileInfo.outputPath = md5sum.digest('hex') + '.' + (ext === 'json' ? 'js' : ext)
      }

      if (!this._requestId)
        this._requestId = 0
      if (!fileInfo.vendor) {
        this._requestId++
        fileInfo.name = this._requestId.toString(32);
      }
    },
    postBuild: async function () {
      const srcPath = path.join(this.inputPath, this.options.assets)
      if (await util.exists(srcPath)) {
        // copy assets files
        const distPath = path.join(this.basePath, this.options.distPath, this.options.inputPath)
        await util.readdir(srcPath, file => {
          this.logFileName(file)
          return util.copy(path.join(srcPath, file), path.join(distPath, file))
        })
      }
    },
    compilers: {
      html: {
        preBuild: 'function $req(n,f){if(!f)return $req[n]();$req[n]=function(){var m={exports:{}};f(m,m.exports,$req);m=m.exports;$req[n]=function(){return m};return m}};document.addEventListener(\'DOMContentLoaded\',function(){$req(\'{1}\')});',
        postBuild: '',
        liveReload: '',
        compile: async function (options) {
          const time = Math.ceil(new Date() / 1000)
          const links = []
          const jsPath = this.changeExtension(options.fileInfo.inputPath, 'js')
          if (await this.statInput(jsPath)) {
            const requireFileInfo = await this.require(jsPath, options.fileInfo)
            const list = this.dependencyList(requireFileInfo.outputPath)

            const vendorJsList = []
            const vendorCssList = []
            const cssList = []
            const jsList = []
            const templateList = []

            list.forEach(file => {
              const ext = path.extname(file.outputPath).substr(1)
              if (file.vendor) {
                if (ext === 'css')
                  vendorCssList.push(file)
                if (ext === 'js')
                  vendorJsList.push(file)
              } else {
                if (ext === 'css')
                  cssList.push(file)
                if (ext === 'js')
                  jsList.push(file)
                if (ext === 'template')
                  templateList.push(file)
              }
            })

            // vendorNames = vendorNames.join()
            let license = await util.read(path.join(this.basePath, 'LICENSE'))
            license = license.match(/^[\s\S]+Copyright.+/) || license // minimal license text
            if (Array.isArray(license))
              license = license[0]

            const preBuild = options.compiler.preBuild.replace(/\$req/g, this.options.requireName).replace(/\{1\}/g, requireFileInfo.name)
            const postBuild = options.compiler.postBuild.replace(/\$req/g, this.options.requireName).replace(/\{1\}/g, requireFileInfo.name)

            await util.mkdir(this.distPath)

            let generateVendorFile = false
            if (!this.distVendorFiles)
              this.distVendorFiles = {}

            vendorJsList.forEach(name => {
              if (!this.distVendorFiles[name]) {
                generateVendorFile = true
                this.distVendorFiles[name] = true
              }
            })

            if (generateVendorFile && vendorJsList.length) {
              this.logFileName(this.options.vendor + '.js')
              await this.writeDist(this.options.vendor + '.js', async write => {
                await write(preBuild)
                for (var i = 0; i < vendorJsList.length; i++) {
                  await write('\n')
                  var content = await this.readOutput(vendorJsList[i])
                  await write(content.replace(/\/\*[\s\S]+?\*\//, '')) // remove comments
                }
                await write(postBuild)
              })
              links.push('<script src="' + this.options.vendor + '.js?' + time + '"></script>')
            }

            if (generateVendorFile && vendorCssList.length) {
              this.logFileName(this.options.vendor + '.css')
              await this.writeDist(this.options.vendor + '.css', async write => {
                for (var i = 0; i < vendorCssList.length; i++) {
                  var content = await this.readOutput(vendorCssList[i])
                  await write(content.replace(/\/\*[\s\S]+?\*\//, '')) // remove comments
                  if (i !== 0)
                    await write('\n')
                }
              })
              links.push('<link rel="stylesheet" href="' + this.options.vendor + '.css?' + time + '">')
            }

            if (cssList.length) {
              let buildCssName = options.fileInfo.outputPath + '.css'
              let cssName = this.changeExtension(options.fileInfo.outputPath, 'css')
              await this.writeOutput(buildCssName, async write => {
                await write('/*\n' + license + '\n*/\n')
                for (var i = 0; i < cssList.length; i++) {
                  await write('\n/* ' + cssList[i].inputPath + ' */\n')
                  await write(await this.readOutput(cssList[i]))
                }
              })

              if (this.options.minify) {
                const CleanCSS = require('clean-css')
                if (CleanCSS) {
                  cssName = this.changeExtension(options.fileInfo.outputPath, 'css')
                  let css = await this.readOutput(buildCssName)
                  css = new CleanCSS({}).minify(css)
                  if (css.errors.length)
                    throw new Error(css.errors[0])
                  if (css.warnings.length)
                    this.logWarning(css.warnings[0])
                  await this.writeDist(cssName, '/*\n' + license + '\n*/\n' + css.styles)
                  buildCssName = undefined
                }
              }
              if (buildCssName)
                await util.copy(path.join(this.outputPath, buildCssName), path.join(this.distPath, cssName))
              this.logFileName(cssName)
              links.push('<link rel="stylesheet" href="' + cssName + '?' + time + '">')
            }

            let buildJsName = options.fileInfo.outputPath + '.js'
            let jsName = this.changeExtension(options.fileInfo.outputPath, 'js')
            await this.writeOutput(buildJsName, async write => {
              await write('/** @license\n' + license + '\n*/\n')
              if (!generateVendorFile)
                await write(preBuild)
              for (var i = 0; i < jsList.length; i++) {
                await write('\n/* ' + jsList[i].inputPath + ' */\n')
                await write(await this.readOutput(jsList[i]))
              }
              if (!generateVendorFile) {
                await write('\n')
                await write(postBuild)
              }
            })

            if (this.options.minify) {
              jsName = this.changeExtension(options.fileInfo.outputPath, 'js')
              const terserMinify = require('terser').minify
              if (terserMinify) {
                const result = terserMinify(await this.readOutput(buildJsName, {
                  compress: {
                    dead_code: true,
                    global_defs: {
                      BUILD: this.options.mode,
                      DEBUG: this.options.mode === 'developer',
                      LIVE: !!this.options.live,
                      DEVELOPER: this.options.mode === 'developer',
                      PRODUCTION: this.options.mode === 'production'
                    }
                  }
                }))
                if (result.error)
                  throw new Error('MINIFY: ' + buildJsName + '. ' + result.error)
                await this.writeDist(jsName, result.code)
                buildJsName = undefined
              }
            }
            if (buildJsName)
              await util.copy(path.join(this.outputPath, buildJsName), path.join(this.distPath, jsName))
            this.logFileName(jsName)
            links.push('<script src="' + jsName + '?' + time + '"></script>')

            if (templateList) {
              for (let i = 0; i < templateList.length; i++)
                links.push(await this.readOutput(templateList[i].outputPath))
            }

            const content = await this.readInput(options.fileInfo)

            let includePos = content.indexOf('</head>')
            if (includePos < 0)
              throw new Error('Html head not found')
            else {
              const pos = content.lastIndexOf('</script>', includePos)
              if (pos > 0)
                includePos = pos + 9
            }

            await this.writeDist(options.fileInfo,
              content.substr(0, includePos) + '  ' + links.join('\n  ') + '\n' + content.substr(includePos))
            this.logFileName(options.fileInfo.outputPath)
          }
          return {}
        }
      }
    }
  }
}

class AppBuilder extends events.EventEmitter {
  /**
   * @description Prepare AppBuilder
   *
   * @param {object} options builder options
   * @param {string} options.inputPath input application path (default: 'app')
   * @param {string} options.outputPath output/build files path (default: 'build')
   * @param {string} options.distPath distribution files path (default: 'dist')
   * @param {string} options.assets assets files subdirectory (default: 'assets')
   * @param {string} options.vendor pre-generated vendor file (default: 'vendor')
   * @param {string} options.mode build mode 'developer': many small files, 'production':single files (default: 'production')
   * @param {boolean} options.minify minify generated files (default: false)
   * @param {boolean} options.live generate live reload stubs in html (default: false)
   * @param {boolean} options.log log file names (default: false)
   * @param {boolean} options.rebuild rebuild required files (default: true)
   * @param {boolean} options.requireName require module name (default: $req)
   */
  constructor (options) {
    super()
    this.options = Object.assign({
      inputPath: 'app',
      outputPath: 'build',
      distPath: 'dist',
      assets: 'assets',
      vendor: 'vendor',
      mode: 'production',
      minify: true,
      buildFiles: ['html'],
      lookupFiles: ['.js', '.vue', '/index.js'],
      log: true,
      rebuild: true,
      requireName: '$req'
    }, options || {})

    this.requireMap = {}
    this.files = {}

    this.ready = false
    this.processing = 0;

    this.basePath = process.cwd()
    this.inputPath = path.join(this.basePath, this.options.inputPath)
    this.outputPath = path.join(this.basePath, this.options.outputPath)
    this.distPath = path.join(this.basePath, this.options.distPath)

    this.compilers = {}
    this.builders = builders

    this.messageCache = {}

    if (this.options.changed)
      this.on('changed', this.options.changed)
  }

  depends (fileInfo, baseFileInfo) {
    if (!fileInfo || !baseFileInfo || !fileInfo.outputPath)
      return
    let thisFileInfo = this.files[baseFileInfo.outputPath]
    if (!thisFileInfo)
      thisFileInfo = this.files[baseFileInfo.outputPath] = Object.assign({}, baseFileInfo)
    thisFileInfo.deps = thisFileInfo.deps || {}
    thisFileInfo.deps[fileInfo.outputPath] = true
  }

  dependencyList (path) {
    const usedFile = {}
    const list = []
    const walk = path => {
      const fileInfo = this.files[path]
      if (fileInfo && fileInfo.deps) {
        for (var n in fileInfo.deps)
          walk(n)
      }
      if (!usedFile[path]) {
        usedFile[path] = true
        list.push(fileInfo)
      }
    }
    walk(path)
    return list
  }

  changed (fileInfo) {
    let thisFileInfo = this.files[fileInfo.outputPath]
    const time = fileInfo.time || Math.ceil(new Date() / 1000)
    if (thisFileInfo && thisFileInfo.time === time)
      return

    if (!thisFileInfo)
      this.files[fileInfo.outputPath] = thisFileInfo = Object.assign({}, fileInfo)

    thisFileInfo.time = time
    if (this.ready)
      this.emit('changed', thisFileInfo)
  }

  statInput (fileInfo, allways) {
    if (typeof (fileInfo) === 'object')
      fileInfo = fileInfo.inputPath
    return util.stat(path.join(this.inputPath, fileInfo), allways !== false)
  }

  statOutput (fileInfo, allways) {
    if (typeof (fileInfo) === 'object')
      fileInfo = fileInfo.outputPath
    return util.stat(path.join(this.outputPath, fileInfo), allways !== false)
  }

  readInput (fileInfo) {
    if (typeof (fileInfo) === 'object')
      fileInfo = fileInfo.inputPath
    return util.read(path.join(this.inputPath, fileInfo))
  }

  readOutput (fileInfo) {
    if (typeof (fileInfo) === 'object')
      fileInfo = fileInfo.outputPath
    return util.read(path.join(this.outputPath, fileInfo))
  }

  readDist (fileInfo) {
    if (typeof (fileInfo) === 'object')
      fileInfo = fileInfo.outputPath
    return util.read(path.join(this.distPath, fileInfo))
  }

  writeOutput (fileInfo, data) {
    if (typeof (fileInfo) === 'object')
      fileInfo = fileInfo.outputPath
    return util.write(path.join(this.outputPath, fileInfo), data)
  }

  writeDist (fileInfo, data) {
    if (typeof (fileInfo) === 'object')
      fileInfo = fileInfo.outputPath
    return util.write(path.join(this.distPath, fileInfo), data)
  }

  changeExtension (path, ext) {
    const pos = path.lastIndexOf('.')
    return pos >= 0 ? (path.substr(0, pos + 1) + ext) : (path + '.' + ext)
  }

  async require (name, baseFileInfo) {
    let fileInfo
    if (typeof name === 'string') {
      fileInfo = { name: name, inputPath: name, ext: path.extname(name).substr(1) }
      this.updateFileInfo(fileInfo)
    } else {
      fileInfo = name
      name = fileInfo.name
    }
    if (this.requireMap[name]) {
      fileInfo = this.requireMap[name]
      this.depends(fileInfo, baseFileInfo)
      return fileInfo
    }

    fileInfo.outputPath = (fileInfo.outputPath || fileInfo.inputPath).toLowerCase()
    if (fileInfo.vendor) {
      fileInfo.outputPath = (this.options.vendor + '/' + fileInfo.outputPath).toLowerCase()
      await util.mkdir(path.join(this.outputPath, this.options.vendor))
    }

    // download file
    if (fileInfo.url) {
      const outputPath = path.join(this.outputPath, fileInfo.outputPath)

      let statOutput = await util.stat(outputPath, true)
      if (!statOutput) {
        let promise
        if (fileInfo.ext === 'json') {
          promise = util.download(fileInfo.url).then(content => this.writeOutput(fileInfo, this.compilers.js.declare(name, 'module.exports=' + content)))
        } else if (fileInfo.ext === 'js' || fileInfo.ext === 'css') {
          promise = util.download(fileInfo.url).then(content => util.write(outputPath, this.compilers.js.declare(name, content)))
        } else
          promise = util.download(fileInfo.url, outputPath)
        statOutput = await promise.then(() => util.exists(outputPath)).catch(noop)
        if (!statOutput)
          throw new Error('Download "' + fileInfo.url + '" failed')
        this.logFileName(fileInfo.url, fileInfo.outputPath)
      }

      fileInfo.time = Math.ceil(statOutput.ctime / 1000)

      this.requireMap[fileInfo.name] = fileInfo
      if (fileInfo.inputPath)
        this.requireMap[fileInfo.inputPath] = fileInfo
      this.changed(fileInfo)
      this.depends(fileInfo, baseFileInfo)
      return fileInfo
    }

    // external/vendor module
    if (fileInfo.vendor) {
      let inputFileName, inputPath, outputPath, statInput

      const getVendor = async (fileName, dir) => {
        inputFileName = fileName
        const filePath = (this.options.vendor + '/' + fileName)
        inputPath = dir ? path.join(dir, fileName) : path.join(this.inputPath, filePath)
        outputPath = path.join(this.outputPath, filePath)
        statInput = await util.stat(inputPath, true)
        if (statInput) {
          fileInfo.inputPath = filePath
          fileInfo.outputPath = filePath
        }
        return statInput
      }

      let moduleDir
      let ext = ['.js', '.min.js', '.umd.js']
      if (this.options.minify)
        ext = ['.min.js', '.umd.js', '.js']

      for (let i = 0; i < ext.length; i++)
        if (await getVendor(name + ext[i]))
          break

      let statOutput
      // check from Modules
      if (!statInput) {
        try {
          moduleDir = path.dirname(require.resolve(name))
          for (let i = 0; i < ext.length; i++)
            if (await getVendor(name + ext[i], moduleDir))
              break
        } catch (err) {
        }
      }

      // check from CDN
      if (!statInput) {
        let inputName = name + '.min.js'
        let filePath = this.options.vendor + '/' + inputName
        fileInfo.outputPath = filePath
        outputPath = path.join(this.outputPath, filePath)
        statOutput = await util.stat(outputPath, true)
        if (!statOutput || !statOutput.size) {
          const url = 'https://cdn.jsdelivr.net/npm/' + name + '/dist/'
          let content = await util.download(url + inputName).catch(noop)
          if (!content) {
            inputName = name + '.umd.js'
            content = await util.download(url + inputName).catch(noop)
          }
          if (content) {
            this.logFileName(inputName, fileInfo.outputPath)
            await this.writeOutput(fileInfo, this.compilers.js.declare(fileInfo.name, content))

            filePath = this.options.vendor + '/' + name + '.min.css'
            if (await util.download(url + name + '.min.css', path.join(this.outputPath, filePath)).catch(noop))
              this.logFileName(name + '.min.css', filePath)
          }
        }
      }

      statOutput = await util.stat(outputPath, true)

      if (!statInput && !statOutput)
        throw new Error('Module "' + name + '" not found')

      if (!statOutput || (statInput && statOutput.mtime < statInput.mtime)) {
        this.logFileName(inputFileName, fileInfo.outputPath)
        // await util.copy(inputPath, outputPath)
        await this.writeOutput(fileInfo, this.compilers.js.declare(fileInfo.name, await util.read(inputPath)))
      }

      if (!statInput)
        statInput = statOutput

      fileInfo.time = Math.ceil(statInput.ctime / 1000)

      this.requireMap[name] = fileInfo
      if (fileInfo.inputPath)
        this.requireMap[fileInfo.inputPath] = fileInfo
      this.changed(fileInfo)
      this.depends(fileInfo, baseFileInfo)

      if (!moduleDir) {
        statOutput = undefined
        if (!await getVendor(name + '.min.css')) {
          statOutput = await util.stat(outputPath, true)
          if (!statOutput)
            await getVendor(name + '.css')
          else
            statInput = statOutput
        }
        if (statInput) {
          statOutput = await util.stat(outputPath, true)
          if (!statOutput || statOutput.mtime < statInput.mtime) {
            this.logFileName(inputFileName, fileInfo.outputPath)
            await util.copy(inputPath, outputPath)
          }
          this.changed(fileInfo)
          this.depends(fileInfo, baseFileInfo)
        }
      }

      return fileInfo
    }

    const fileInfoPath = fileInfo.inputPath
    let statInput = await this.statInput(fileInfo.inputPath)
    if (!statInput || statInput.isDirectory()) {
      for (var i = 0; (!statInput || statInput.isDirectory()) && i < this.options.lookupFiles.length; i++) {
        fileInfo.inputPath = fileInfoPath + this.options.lookupFiles[i]
        fileInfo.ext = path.extname(fileInfo.inputPath).substr(1)
        statInput = await this.statInput(fileInfo.inputPath)
      }
    }

    const compiler = this.compilers[fileInfo.ext]
    if (!compiler)
      throw new Error('File "' + fileInfo.inputPath + '" not supported')

    fileInfo.compiler = compiler

    const ext = compiler.script ? compilerExtension.script : compiler.style ? compilerExtension.style : fileInfo.ext
    fileInfo.outputPath = this.changeExtension(fileInfo.inputPath, ext)
    fileInfo.time = statInput ? Math.ceil(statInput.mtime / 1000) : 0

    this.requireMap[name] = fileInfo
    this.requireMap[fileInfo.inputPath] = fileInfo

    this.depends(fileInfo, baseFileInfo)

    if (!statInput || statInput.isDirectory()) {
      throw new Error('File "' + fileInfo.inputPath + '" not found')
    } else {
      await this.buildFile(fileInfo, baseFileInfo)
    }
    return fileInfo
  }

  async buildFile (fileInfo, baseFileInfo) {
    if (this._closed || !fileInfo || !fileInfo.compiler)
      return

    const checkFiles = []
    const statInput = await this.statInput(fileInfo.inputPath, false)
    fileInfo.time = Math.ceil(statInput.mtime / 1000)

    const ext = path.extname(fileInfo.outputPath).substr(1)
    checkFiles.push(fileInfo.outputPath)
    for (const type in compilerExtension) {
      if (fileInfo.compiler[type] && compilerExtension[type] !== ext)
        checkFiles.push(this.changeExtension(fileInfo.outputPath, compilerExtension[type]))
    }
    let changed = false
    await Promise.all(checkFiles.map(file => {
      return this.statOutput(file).then(statsOutput => {
        if (!statsOutput || statsOutput.mtime < statInput.mtime)
          changed = true
      })
    }))
    if (changed || this.options.rebuild) {
      this.processing++;
      try {
        this.emit('build', fileInfo)
        if (!fileInfo.compiler.compile) {
          await util.copy(path.join(this.inputPath, fileInfo.inputPath), path.join(this.outputPath, fileInfo.outputPath))
          this.logFileName(fileInfo.name, fileInfo.outputPath)
          this.changed(fileInfo)
          this.depends(fileInfo, baseFileInfo)
        } else {
          const response = await fileInfo.compiler.compile({
            data: await this.readInput(fileInfo),
            builder: this,
            compiler: fileInfo.compiler,
            fileInfo: fileInfo
          });

          for (const type in compilerExtension) {
            if (response[type]) {
              let outputPath = fileInfo.outputPath
              if (type === 'script')
                response[type] = this.compilers.js.declare(fileInfo.name, response[type])
              outputPath = this.changeExtension(fileInfo.outputPath, compilerExtension[type])
              let writeFileInfo = fileInfo
              if (fileInfo.outputPath !== outputPath)
                writeFileInfo = Object.assign({}, fileInfo, { outputPath: outputPath })
              this.writeOutput(outputPath, response[type])
              this.logFileName(fileInfo.name, outputPath)
              this.changed(writeFileInfo)
              this.depends(writeFileInfo, writeFileInfo === fileInfo ? baseFileInfo : fileInfo)
            }
          }
        }
      } finally {
        this.processing--;
        if (this.ready && !this.processing)
          this.emit('ready')
      }
    }
  }

  logFileName (name, outfile) {
    if (this.options.log)
      console.log('[BUILD] ' + name + (outfile ? ' => ' + outfile : ''))
  }

  logInfo (text) {
    if (this.options.log)
      console.info('[BUILD] ' + text)
  }

  logWarning (error) {
    if (this.options.log)
      console.warning('[BUILD] ' + error)
  }

  logError (error) {
    console.error('[BUILD] ' + (error.stack || error))
  }

  cleanup () {
    return util.rmdir(this.outputPath)
  }

  updateFileInfo (fileInfo) {
    if (fileInfo.url) {
      if (fileInfo.ext === 'js' || fileInfo.ext === 'css' || fileInfo.ext === 'json') {
        const crypto = require('crypto')
        const md5sum = crypto.createHash('md5')
        md5sum.update(fileInfo.name)

        const ext = fileInfo.ext
        fileInfo.outputPath = md5sum.digest('hex') + '.' + (ext === 'json' ? 'js' : ext)
      } else {
        fileInfo.vendor = false
        fileInfo.outputPath = fileInfo.url.match(/([^/?]+)($|\?)/)[1].toLowerCase()
      }
    }
  }

  preBuild () { }

  postBuild () { }

  async build () {
    assert(this.builders[this.options.mode], 'Builder "' + this.options.mode + '" not defined')
    const builderInfo = this.builders[this.options.mode]
    for (const n in builderInfo) {
      if (typeof builderInfo[n] === 'function')
        this[n] = builderInfo[n].bind(this)
    }

    for (const n in compilers) {
      let compiler = Object.assign({ name: n }, compilers[n])
      if (builderInfo.compilers && builderInfo.compilers[n])
        compiler = Object.assign({}, builderInfo.compilers[n])
      for (const func in compiler) {
        if (typeof compiler[func] === 'function')
          compiler[func] = compiler[func].bind(this)
      }
      this.compilers[n] = compiler
    }

    await this.preBuild()
    await util.readdir(this.inputPath, file => {
      const ext = path.extname(file).substr(1)
      if (!this._closed && this.options.buildFiles.indexOf(ext) >= 0)
        return this.require(file)
    })
      .catch(err => {
        if (err.code === 'MODULE_NOT_FOUND') {
          const module = err.message.match(/'([^']+)'/)
          if (module) {
            console.error('Module \'' + module[1] + '\' not found. Use: npm i ' + module[1])
            return
          }
        }
        console.error(err)
      })
      .then(() => {
        this.ready = true
        this.emit('ready')
      })
    return this.postBuild()
  }

  checkReady (cb) {
    if (this.ready && !this.processing)
      cb()
    else
      this.once('ready', cb)
  }

  close () {
    this._closed = true;
    if (this._unwatch) {
      this._unwatch()
      delete this._unwatch
    }
  }

  plugin (server) {
    if (this.options.assets && fs.existsSync(path.join(this.inputPath, this.options.assets)))
      server.static(this.options.assets, path.join(this.inputPath, this.options.assets), { maxAge: this.options.live ? 1 : 0 })

    server.static('/', this.outputPath, {
      maxAge: this.options.live ? 1 : 0,
      hook: (req, res, next) => {
        this.checkReady(next)
      }
    })

    if (this.options.live) {
      let initWatch = true
      util.watch(this.inputPath, (action, path) => {
        if (!this._closed && !initWatch && (action === 'changed' || action === 'created')) {
          if (this.requireMap[path]) {
            delete this.messageCache['notused/' + path];
            this.logInfo('building: ' + path)
            this.buildFile(this.requireMap[path]).catch(err => {
              this.logError('file: ' + path + ', ' + err)
            })
          } else {
            if (!this.messageCache['notused/' + path]) {
              this.messageCache['notused/' + path] = true
              this.logInfo('file: ' + path + ' is not used')
            }
          }
        }
      }).then(unwatch => {
        if (this._closed)
          unwatch()
        else
          this._unwatch = unwatch
        initWatch = false
      })

      server.websocket('/livereload', ws => {
        var listener = function (fileInfo) {
          ws.send(JSON.stringify({ action: 'changed', path: fileInfo.outputPath }))
        }
        this.on('changed', listener)
        ws.on('close', () => {
          this.removeListener('changed', listener)
        })
        ws.on('message', function (msg) {
          ws.send(msg)
        })
      })
    }
  }

  /** @description Build JS browser app
   * @async
   * @param {object} options builder options
   * @param {string} options.inputPath application files path (default: 'app')
   * @param {string} options.outputPath output/build files path (default: 'build')
   * @param {string} options.distPath distribution files path (default: 'dist')
   * @param {string} options.assets assets files subdirectory (default: 'assets')
   * @param {string} options.vendor pre-generated vendor file (default: 'vendor')
   * @param {string} options.mode build mode 'developer': many small files, 'production':single files (default: 'production')
   * @param {boolean} options.minify minify generated files (default: true)
   * @param {boolean} options.live generate live reload stubs in html (default: false)
   * @param {boolean} options.log log file names (default: true)
   * @param {boolean} options.rebuild rebuild required files (default: true)
   * @returns {Promise<boolean>}
   */
  static build (options) {
    process.on('unhandledRejection', (error, promise) => {
      console.error('Uncaught Error', error.stack || error)
    })

    options = Object.assign({
      rebuild: true,
      build: 'production',
      minify: true,
      log: true
    }, parseArgs(options || {}))

    if (options.help) {
      console.log('build {options}')
      console.log('  -inputPath={inputPath} input application files path (default: "app")')
      console.log('  -outputPath={inputPath} output build files path (default: "build")')
      console.log('  -distPath={distPath} distribution files path (default: "dist")')
      console.log('  -assets={assetsPath} assets subfolder (default: "assets")')
      console.log('  -vendor={vendorPrefix} pre-generated vendor file prefix (default: "vendor")')
      console.log('  -mode={mode} build mode: developer - many small files, production - single files (default: "developer")')
      console.log('  -[no]minify minify output files (default: false)')
      console.log('  -[no]live generate livereload stubs (default: true)')
      console.log('  -[no]log verbose log (default: true)')
      console.log('  -[no]rebuild rebuild on start (default: true)')
      return
    }

    const builder = new AppBuilder(options)
    builder.logInfo('mode:' + builder.options.mode + ', minify:' + builder.options.minify)
    return builder.build()
      .then(() => {
        builder.logInfo('done')
      })
      .catch(err => {
        builder.logError(err)
      })
  }

  /** @description Start http server for live reload
   * @async
   * @param {object} options builder options
   * @param {string} options.port server port (default: 3000)
   * @param {string} options.cors enable CORS (default: true)
   * @param {string} options.public static public content (ex: 'public', optional)
   * @param {string} options.proxy proxy suburl (ex: '/rest/api=http://localhost:8080/rest,/static=http://...')
   * @param {string} options.server http server instance (optional)
   * @param {string} options.inputPath input appilcation files (default: 'app')
   * @param {string} options.outputPath output build files path (default: 'build')
   * @param {string} options.distPath distribution files path (default: 'dist')
   * @param {string} options.assets assets subfolder (default: 'assets')
   * @param {string} options.vendor pre-generated vendor file (default: 'vendor')
   * @param {string} options.mode build mode 'developer': many small files, 'production':single files (default: 'production')
   * @param {boolean} options.minify minify generated files (default: false)
   * @param {boolean} options.live generate live reload stubs in html (default: true)
   * @param {boolean} options.log log file names (default: true)
   * @param {boolean} options.rebuild rebuild required files (default: true)
   * @returns {Promise<boolean>}
   */
  static server (options) {
    process.on('unhandledRejection', (error, promise) => {
      console.error('Uncaught Error', error)
    })

    options = Object.assign({
      mode: 'developer',
      live: true,
      rebuild: true,
      minify: false,
      cors: true,
      port: 3000
    }, parseArgs(options || {}))

    if (options.version) {
      console.log(require('root-require')('package.json').version)
      return
    }
    if (options.help) {
      console.log('server {options}')
      console.log('  -port={port} server port (default: 3000)')
      console.log('  -[no]cors use cors (default: cors)')
      console.log('  -public={publicPath} static public content (optional)')
      console.log('  -proxy={url}={remoteUrl},... proxy suburl(ex: "/rest/api=http://localhost:8080/rest,/static=http://..."')
      console.log('  -inputPath={inputPath} input application files path (default: "app")')
      console.log('  -outputPath={inputPath} output build files path (default: "build")')
      console.log('  -distPath={distPath} distribution files path (default: "dist")')
      console.log('  -assets={assetsPath} assets subfolder (default: "assets")')
      console.log('  -vendor={vendorPrefix} pre-generated vendor file prefix (default: "vendor")')
      console.log('  -mode={mode} build mode: developer - many small files, production - single files (default: "developer")')
      console.log('  -[no]minify minify output files (default: nominfy)')
      console.log('  -[no]live generate livereload stubs (default: live)')
      console.log('  -[no]log verbose log (default: log)')
      console.log('  -[no]rebuild on start (default: rebuild)')
      return
    }
    const httpserver = require('./microserver')
    let server = options.server
    if (!server) {
      server = httpserver.server(options);
      server.on('listen', port => console.log('Server listening on port: ' + port))
      server.on('error', err => console.error('Server start failed: ' + err))
      server.GET('/favicon.ico', function (req, res) {
        res.setHeader('Content-Type', 'image/x-icon')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(Buffer.from('AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAABILAAASCwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDuEEAg7hBAYO4QQGDuEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDuEEAg7hBAIO4QUCDuEFAg7hBAIO4QQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg7hBAIO4QRCDuEG9g7hBvYO4QRCDuEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg7hBAIO4QQCDuEFng7hB+4O4QfuDuEFng7hBAIO4QQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIO4QQCDuEEhg7hB1IO4Qf+DuEH/g7hB1IO4QSGDuEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIO4QQCDuEEBg7hBiIO4Qf+DuEH/g7hB/4O4Qf+DuEGIg7hBAYO4QQAAAAAAAAAAAAAAAAAAAAAAAAAAAIO4QQCDuEEAg7hBOIO4QeeDuEH/gbFA/4GxQP+DuEH/g7hB54O4QTiDuEEAg7hBAAAAAAAAAAAAAAAAAAAAAACDuEEAg7hBCYO4QaiDuEH/g7hB/3GBO/9xgTv/g7hB/4O4Qf+DuEGog7hBCYO4QQAAAAAAAAAAAAAAAACDuEEAg7hBAIO4QVSDuEH1g7lB/3yjP/9iVDb/YlQ2/3yjP/+DuUH/g7hB9YO4QVSDuEEAg7hBAAAAAAAAAAAAg7hBAIO4QRaDuEHEg7hB/4K2Qf9scjn/Xkg1/15INf9scjn/grZB/4O4Qf+DuEHEg7hBFoO4QQAAAAAAg7hBAIO4QQCDuEFzg7hB/YS6Qf94lz3/YE42/15JNf9eSTX/YE42/3iXPf+EukH/g7hB/YO4QXODuEEAg7hBAIO4QQCDuEEog7hB3IO5Qf+BsUD/Z2U4/11HNf9eSTX0Xkk19F1HNf9nZTj/gbFA/4O5Qf+DuEHcg7hBKIO4QQCDuEEEg7hBk4O4Qf+DuUH/dIk8/15KNf9eSTX/Xko1j15KNY9eSTX/Xko1/3SJPP+DuUH/g7hB/4O4QZODuEEEg7hBTIO4QeyDuUH/fqg//2RaN/9eSDX/Xkk1119MNSJfTDUiXkk1115INf9kWjf/fqg//4O5Qf+DuEHsg7hBTIO4QZ6DuEHUg7lB03GBO9NeSDXTXkk1019KNWVbQTQAW0E0AF9KNWVeSTXTXkg103GBO9ODuUHTg7hB1IO4QZ6DuEEYg7hBGIK2QRhnZDgYXUY1GF5JNRdfSzUGXko1AF5KNQBfSzUGXkk1F11GNRhnZDgYgrZBGIO4QRiDuEEY/n8AAP5/AAD8PwAA/D8AAPgfAADwDwAA8A8AAOAHAADgBwAAwAMAAMADAACAAQAAAAAAAAAAAAABgAAAAYAAAA==', 'base64'))
      })
    }

    if (options.proxy) {
      if (typeof options.proxy === 'string') {
        options.proxy.replace(/([^=,]+)=([^,]+)/g, (_, path, remote) => {
          server.use(path + '/:path*', httpserver.proxy(remote))
        })
      } else {
        for (var path in options.proxy)
          server.use(path + '/:path*', httpserver.proxy(options.proxy[path]))
      }
    }

    if (options.mode === 'developer') {
      const builder = new AppBuilder(options)
      server.on('close', () => {
        builder.close()
      })
      builder.build().then(() => builder.plugin(server)).catch(console.error)
    }
    return server
  }

  /** @description Init empty project
   */
  static create (options) {
    options = parseArgs(options || {})
    const builder = new AppBuilder(options)

    const inputPath = builder.options.inputPath
    return util.exists(inputPath).then(exists => {
      if (!exists)
        return util.mkdir(inputPath)
          .then(() => util.write(path.join(inputPath, 'index.html'),
            `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>Vue app</title>
  </head>
  
  <body>
    <div id="app"></div>
  </body>
</html>`))
          .then(() => util.write(path.join(inputPath, 'index.js'),
            `import Vue from 'vue'
import App from './App.vue'

Vue.config.productionTip = false
new Vue({render: h => h(App)}).$mount('#app'))
`))
          .then(() => util.write(path.join(inputPath, 'App.vue'),
            `<template>
  <div id="app">
    <router-view></router-view>
  </div>
</template>

<style>
  html,body,#app {height: 100%}
  body {
    margin: 0;
    padding: 0;
    font-family: Helvetica, sans - serif;
    font-size: 14px;
    background-color: #f2f2f2;
    color: #333333;
  }
</style>

<script lang="js">
</script>`))
    })
  }
}

module.exports = AppBuilder
