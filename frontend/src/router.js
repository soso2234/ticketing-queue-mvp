import { createRouter, createWebHistory } from "vue-router";
import Home from "./pages/Home.vue";
import Queue from "./pages/Queue.vue";
import Seats from "./pages/Seats.vue";
import Complete from "./pages/Complete.vue";

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Home },
    { path: "/queue", component: Queue },
    { path: "/seats", component: Seats },
    { path: "/complete", component: Complete },
  ],
});
