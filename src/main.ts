import Vue from 'vue'
import App from './App.vue'
import LogSdk from './log'
import Raven from "raven-js";
import axios from 'axios'
import TraceKit from 'tracekit'

Vue.config.productionTip = false

new Vue({
  render: (h) => h(App),
}).$mount('#app')


// @ts-ignore
import RavenVue from 'raven-js/plugins/vue'

Raven
  .config('http://127.0.0.1:7001/file')
  .addPlugin(RavenVue, Vue)
  .install()

  // .config('http://127.0.0.1:7001/file')
Raven.setTransport(function(option){
  axios.post('http://127.0.0.1:7001/upload/store',{ appName: 'log', ...option.data})
  option.onSuccess();
});
