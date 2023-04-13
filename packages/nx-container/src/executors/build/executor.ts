import { ExecutorContext, names } from '@nrwl/devkit';
import { getExecOutput, getInput, getProjectRoot, interpolate, loadPackage, logger } from '@nx-tools/core';
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as context from './context';
import { EngineAdapter } from './engines/engine-adapter';
import { EngineFactory } from './engines/engine.factory';
import { DockerBuildSchema } from './schema';

const GROUP_PREFIX = 'Nx Container';

export async function run(options: DockerBuildSchema, ctx?: ExecutorContext): Promise<{ success: true }> {
  const tmpDir = context.tmpDir();

  try {
    const defContext = context.defaultContext();
    const inputs: context.Inputs = await context.getInputs(
      defContext,
      {
        ...options,
        file: options.file || join(getProjectRoot(ctx), 'Dockerfile'),
      },
      ctx
    );

    const prefix = names(ctx?.projectName || '').constantName;
    const provider = getInput('engine', { prefix, fallback: options.engine || 'docker' });

    const engine: EngineAdapter = EngineFactory.create(provider);
    await engine.initialize(inputs, ctx);

    if (options.metadata?.images) {
      const { getMetadata } = await loadPackage('@nx-tools/container-metadata', 'Nx Container Build Executor');
      logger.startGroup(GROUP_PREFIX, 'Generating metadata');
      const meta = await getMetadata(options.metadata, ctx);
      inputs.labels = meta.getLabels();
      inputs.tags = meta.getTags();
    }

    logger.startGroup(GROUP_PREFIX, `Starting build...`);
    const args: string[] = await engine.getArgs(inputs, defContext);
    const buildCmd = engine.getCommand(args);
    await getExecOutput(
      buildCmd.command,
      buildCmd.args.map((arg) => interpolate(arg)),
      {
        ignoreReturnCode: true,
      }
    ).then((res) => {
      if (res.stderr.length > 0 && res.exitCode != 0) {
        throw new Error(`buildx failed with: ${res.stderr.match(/(.*)\s*$/)?.[0]?.trim() ?? 'unknown error'}`);
      }
    });

    await engine.finalize(inputs, ctx);

    const imageID = await engine.getImageID();
    const metadata = await engine.getMetadata();
    const digest = await engine.getDigest(metadata);

    if (imageID) {
      logger.startGroup(GROUP_PREFIX, `ImageID`);
      logger.info(imageID);
      context.setOutput('imageid', imageID, ctx);
    }
    if (digest) {
      logger.startGroup(GROUP_PREFIX, `Digest`);
      logger.info(digest);
      context.setOutput('digest', digest, ctx);
    }
    if (metadata) {
      logger.startGroup(GROUP_PREFIX, `Metadata`);
      logger.info(metadata);
      context.setOutput('metadata', metadata, ctx);
    }
  } finally {
    await cleanup(tmpDir);
  }

  return { success: true };
}

async function cleanup(tmpDir: string): Promise<void> {
  if (tmpDir.length > 0 && existsSync(tmpDir)) {
    logger.info(`Removing temp folder ${tmpDir}`);
    await rm(tmpDir, { recursive: true });
  }
}

export default run;
