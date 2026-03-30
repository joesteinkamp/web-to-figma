document.addEventListener("DOMContentLoaded", () => {
  const captureBtn = document.getElementById("captureBtn");
  const status = document.getElementById("status");

  captureBtn.addEventListener("click", async () => {
    status.textContent = "Capturing... (may take ~10s)";
    status.className = "";
    captureBtn.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ action: "capture" });

      if (response.success) {
        status.textContent = "Sent to Figma!";
        status.className = "success";
      } else {
        status.textContent = response.error;
        status.className = "error";
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = "error";
    } finally {
      captureBtn.disabled = false;
    }
  });
});
