<template>
  <div style="padding:24px">
    <h1>Ticketing MVP</h1>
    <button @click="enter">대기열 들어가기</button>
  </div>
</template>

<script setup>
import { useRouter } from "vue-router";
import { api } from "../api.js";

const router = useRouter();

async function enter() {
  /* todo - 대기열 생성부분 주석처리 */

  /* const userId = "user-" + Math.floor(Math.random() * 100000);
  await api.post("/queue/enter", { userId }); */
  
  router.push("/queue");
}
</script>
