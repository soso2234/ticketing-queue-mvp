<script setup>
import HelloWorld from './components/HelloWorld.vue'
</script>

<template>
  <div style="padding: 24px">
    <nav style="display:flex; gap:12px; margin-bottom: 16px">
      <router-link to="/">Home</router-link>
      <router-link to="/queue">Queue</router-link>
      <router-link to="/seats">Seats</router-link>
      <router-link to="/complete">Complete</router-link>
    </nav>

    <router-view />
  </div>
</template>


<style scoped>
.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}
.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}
.logo.vue:hover {
  filter: drop-shadow(0 0 2em #42b883aa);
}
</style>
