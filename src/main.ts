import Vue from 'vue'
import App from './App.vue'
import LogSdk from './log'
import Raven from "raven-js";

Vue.config.productionTip = false

new Vue({
  render: (h) => h(App),
}).$mount('#app')


// @ts-ignore
import RavenVue from 'raven-js/plugins/vue'

Raven
  .config('https://5c3ab093004246f69cb40ffe690c3413@o422336.ingest.sentry.io/5347833')
  .addPlugin(RavenVue, Vue)
  .install()

Raven.setTransport(function(option){
  console.log(option.data);
  option.onSuccess();
});
