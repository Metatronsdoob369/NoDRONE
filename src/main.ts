import './index.css';
import { initNoDroneCesiumApp } from './cesiumApp';
import { initCopilotDrawer } from './copilotDrawer';

function boot(): void {
  const controller = initNoDroneCesiumApp();
  if (controller) {
    initCopilotDrawer(controller);
  }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  boot();
} else {
  window.addEventListener('DOMContentLoaded', boot);
}
