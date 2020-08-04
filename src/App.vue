<template>
  <div id="app">
    <button  >1</button>
    <button >2</button>
    <button>5</button>
    <button>5</button>
    <button>5</button>
    <button @click="sendError">+</button>
  </div>
</template>

<script lang="ts">
import { Component, Vue } from 'vue-property-decorator'
import HelloWorld from './components/HelloWorld.vue'

@Component({
  components: {
    HelloWorld,
  },
})
export default class App extends Vue {
  public a: any = null

  public sendError() {
    this.a()
  }
}
</script>
