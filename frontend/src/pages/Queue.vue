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
    list.value = [
    { id: 1, user_id: "user-111", status: "WAITING" },
    { id: 2, user_id: "user-222", status: "ALLOWED" }
  ];
  
   /* todo - 대기열 생성부분 주석처리 */
   /*const r = await api.get("/queue");
  list.value = r.data; */
}

load();
</script>
