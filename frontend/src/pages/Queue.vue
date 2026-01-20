<template>
  <div style="padding:24px">
    <h2>Queue</h2>
    <button @click="load">새로고침</button>
    <ul>
      <li v-for="q in list" :key="q.id">
        #{{ q.id }} - {{ q.user_id }} - {{ q.status }}
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { api } from "../api.js";

const list = ref([]);

async function load() {
  const r = await api.get("/queue");
  list.value = r.data.items;
}

load();
</script>
