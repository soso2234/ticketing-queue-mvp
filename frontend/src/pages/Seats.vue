<template>
  <div style="padding:24px">
    <h2>Seats</h2>

    <div style="margin:16px 0">
      <div style="margin-bottom:8px">좌석 선택:</div>
      <div style="display:flex; gap:8px; flex-wrap:wrap">
        <button
          v-for="s in seats"
          :key="s"
          @click="selected = s"
          :style="{
            padding: '8px 10px',
            border: '1px solid #ccc',
            background: selected === s ? '#eee' : '#fff',
            cursor: 'pointer'
          }"
        >
          {{ s }}
        </button>
      </div>
    </div>

    <button @click="reserve" :disabled="!selected || loading">
      {{ loading ? "예약 중..." : "예약하기" }}
    </button>

    <p v-if="error" style="color:crimson; margin-top:12px">{{ error }}</p>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";

const router = useRouter();

const seats = Array.from({ length: 10 }, (_, i) => `A-${i + 1}`);
const selected = ref("");
const loading = ref(false);
const error = ref("");

async function reserve() {
  loading.value = true;
  error.value = "";
  try {
    // MVP: userId는 임시로 랜덤. (다음 섹션에서 allowed userId를 넘기도록 개선 가능)
    const userId = "user-" + Math.floor(Math.random() * 100000);
    const r = await api.post("/reservations", { userId, seatId: selected.value });

    // r.data.id를 complete에 넘김
    router.push({ path: "/complete", query: { reservationId: r.data.id } });
  } catch (e) {
    error.value = "예약에 실패했습니다. 백엔드 예약 API를 먼저 구현해야 합니다.";
    console.error(e);
  } finally {
    loading.value = false;
  }
}
</script>
