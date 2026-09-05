/** Own token artifacts before a child exists, and transfer ownership only after launch. */
export async function prepareEmbeddedStartup<Artifact, Handle>(steps: {
  cleanupTokens(): Promise<void>;
  verify(): Promise<Artifact>;
  launch(artifact: Artifact): Promise<Handle>;
}): Promise<Handle> {
  try {
    await steps.cleanupTokens();
    const artifact = await steps.verify();
    return await steps.launch(artifact);
  } catch (error) {
    await steps.cleanupTokens();
    throw error;
  }
}
