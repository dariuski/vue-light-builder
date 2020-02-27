/* eslint-disable no-unused-expressions */
/* eslint-disable no-undef */
'use strict'

const assert = require('assert')

const util = require('../lib/util')
const AppBuilder = require('../lib/appbuilder')
const Server = require('../lib/server')

describe('builder', function () {
  const server = new Server({ mode: 'developer', port: 'localhost:8187' })
  const url = 'http://' + server.app.get('port') + '/'
  before(async () => {
    await util.mkdir('temp')
    server.static('build')
    server.static('/temp', 'temp')
    await server.start()
  })

  after(async () => {
    server.close()
    await util.rmdir('app').catch(() => { })
    await util.rmdir('dist').catch(() => { })
    await util.rmdir('build').catch(() => { })
    await util.rmdir('temp').catch(() => { })
  })

  it('Create APP', async () => {
    await AppBuilder.create()
    assert(await util.exists('app/App.vue'), 'APP not created')
  });

  it('download', async () => {
    await util.write('temp/t1.js', 'module.exports={t1:"OK"}')
    await util.write('temp/t2.json', '{"t2":"OK"}')

    await util.download(url + 'temp/t1.js')
    await util.download(url + 'temp/t2.json')
  });

  describe('build developer', () => {
    const builder = new AppBuilder({ rebuild: true, log: false, mode: 'developer', minify: false })

    it('build', async () => {
      await util.write('app/index.js', 'import t3 from "./t3"\nimport t1 from "' + url + 'temp/t1.js"\nimport t2 from "' + url + 'temp/t2.json"\nimport app from "App.vue"')
      await util.write('app/t3.js', 'module.exports={t3:"OK"}')
      await builder.build();
    })

    it('files', () => {
      assert(builder.files['index.html'] &&
        builder.files['index.js'] &&
        builder.files['t3.js'] &&
        builder.files['App.js'] &&
        builder.files['App.css'])
    })

    it('downloads', async () => {
      await util.download(url + 'index.js')
      await util.download(url + 't3.js')
      await util.download(url + 'index.html')
      await util.download(url + 'app.js')
      await util.download(url + 'app.css')
    })

    it('content', async () => {
      const content = builder.compilers.js.declare('t3', await util.read('app/t3.js'))
      assert(await util.read('build/t3.js') === content)
    })
  })

  describe('build production', () => {
    const builder = new AppBuilder({ rebuild: true, log: false, mode: 'production', minify: true })

    it('build', async () => {
      await util.write('app/index.js', 'import t3 from "./t3"\nimport t1 from "' + url + 'temp/t1.js"\nimport t2 from "' + url + 'temp/t2.json"\nimport app from "App.vue"')
      await util.write('app/t3.js', 'module.exports={t3:"OK"}')
      await builder.build();
    })

    it('files', () => {
      assert(builder.files['index.html'] &&
        builder.files['index.js'], 'Missing files')
      assert(builder.files['index.js'].name.length === 1, 'Invalid naming')
    })
    /* it('content', async () => {
      const content = builder.updateJs('./t3.js', await util.read('app/t3.js'))
      assert(await util.read('build/app/t3.js') === content)
    }) */
  })
});
