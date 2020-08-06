<template>
  <div id="app">
    <button  >1</button>
    <button >2</button>
    <button>5</button>
    <button>5</button>
    <button>5</button>
    <button @click="sendError">+</button>
    <button @click="get">
      get
    </button>
    <HelloWorld msg="1111"></HelloWorld>

    <div v-html="html"></div>
  </div>
</template>

<script lang="ts">
import { Component, Vue } from 'vue-property-decorator'
import HelloWorld from './components/HelloWorld.vue'
import axios from 'axios'

@Component({
  components: {
    HelloWorld,
  },
})
export default class App extends Vue {
  public a: any = null
  public html = ''

  public sendError() {
    this.a()
  }

  public async get() {
    const s = await axios.post('http://127.0.0.1:7001/upload/store', {
      "appName": "log",
      "project": "file",
      "logger": "javascript",
      "platform": "javascript",
      "request": {
        "headers": {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.105 Safari/537.36"},
        "url": "http://127.0.0.1:9006/"
      },
      "exception": {
        "values": [{
          "type": "TypeError",
          "value": "this.a is not a function",
          "stacktrace": {
            "frames": [{
              "filename": "http://127.0.0.1:9006/js/chunk-vendors.f3c1d423.js",
              "lineno": 7,
              "colno": 51758,
              "function": "HTMLButtonElement.Qo.i._wrapper",
              "in_app": true
            }, {
              "filename": "http://127.0.0.1:9006/js/chunk-vendors.f3c1d423.js",
              "lineno": 7,
              "colno": 13484,
              "function": "HTMLButtonElement.n",
              "in_app": true
            }, {
              "filename": "http://127.0.0.1:9006/js/chunk-vendors.f3c1d423.js",
              "lineno": 7,
              "colno": 11664,
              "function": "ne",
              "in_app": true
            }, {
              "filename": "http://127.0.0.1:9006/js/app.c4d91db9.js",
              "lineno": 1,
              "colno": 4893,
              "function": "a.value",
              "in_app": true
            }]
          }
        }], "mechanism": {"type": "generic", "handled": true}
      },
      "transaction": "http://127.0.0.1:9006/js/app.c4d91db9.js",
      "trimHeadFrames": 0,
      "extra": {"componentName": "component <r>", "lifecycleHook": "v-on handler", "session:duration": 1097},
      "event_id": "851bc07211004fe0bf8f05f889bf5dba"
    })
    this.html = s.data.err_content
  }
}
</script>


<style>
  .red {
    color: red;
  }
</style>
