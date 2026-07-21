// Hello World Plugin — demonstrates Cardinal Frame plugin hooks
export function onTaskCompleted(data, config) {
  console.log(`[hello-world] Task completed: ${data.taskId} (exit=${data.exitCode})`);
}

export function onTaskFailed(data, config) {
  console.log(`[hello-world] Task failed: ${data.taskId} (exit=${data.exitCode})`);
  if (data.stderr) {
    console.log(`[hello-world] stderr: ${data.stderr.slice(0, 200)}`);
  }
}
