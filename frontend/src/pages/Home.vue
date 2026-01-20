<template>
  <div style="padding:24px">
    <h1>Ticketing MVP</h1>
    <button @click="enter" :disabled="loading">
      {{ loading ? "요청 중..." : "대기열 들어가기" }}
    </button>
    <p v-if="error" style="color:crimson; margin-top:12px">{{ error }}</p>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";

const router = useRouter();
const loading = ref(false);
const error = ref("");

async function enter() {
  loading.value = true;
  error.value = "";
  try {
    const userId = "user-" + Math.floor(Math.random() * 100000);
    await api.post("/queue/enter", { userId });
    router.push("/queue");
  } catch (e) {
    error.value = "대기열 진입에 실패했습니다. 백엔드(3000) 실행 상태를 확인하세요.";
    console.error(e);
  } finally {
    loading.value = false;
  }
}
</script>
