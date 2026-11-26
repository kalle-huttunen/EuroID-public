/**
 * Build Temporal workflow bundle for production.
 * Run after `nest build` — bundles dist/src/workflows into dist/src/workflow-bundle.js.
 * The worker loads the bundle via path.join(__dirname, 'workflow-bundle.js') which
 * resolves to dist/src/ at runtime.
 */
const { bundleWorkflowCode } = require('@temporalio/worker');
const { writeFile } = require('fs/promises');
const path = require('path');
const fs = require('fs');

async function bundle() {
  // nest build with baseUrl="./" produces dist/src/workflows/
  const distSrcDir = path.join(__dirname, '..', 'dist', 'src');
  const altDistDir = path.join(__dirname, '..', 'dist');

  // Detect which layout nest build produced
  const workflowsPath = fs.existsSync(path.join(distSrcDir, 'workflows'))
    ? path.join(distSrcDir, 'workflows')
    : path.join(altDistDir, 'workflows');

  // Place bundle next to worker.js (same __dirname at runtime)
  const outputDir = fs.existsSync(path.join(distSrcDir, 'worker.js'))
    ? distSrcDir
    : altDistDir;
  const outputPath = path.join(outputDir, 'workflow-bundle.js');

  console.log(`Bundling workflows from ${workflowsPath}`);
  const { code } = await bundleWorkflowCode({
    workflowsPath,
  });
  await writeFile(outputPath, code);
  console.log(`Bundle written to ${outputPath}`);
}

bundle().catch((err) => {
  console.error(err);
  process.exit(1);
});
