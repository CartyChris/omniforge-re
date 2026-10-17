document.getElementById("paste").addEventListener("click", async () => { document.getElementById("out").textContent = await window.api.readClipboard(); });
fetch("/api/ping");
