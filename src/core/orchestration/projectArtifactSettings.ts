import type { AppSettings, ResearchProject } from "../shared/types.js";

export const PROJECT_ENGINEERING_INPUT_ROOT = "artifacts/inputs";

export function settingsWithProjectArtifactRoot(settings: AppSettings, project: ResearchProject): AppSettings {
  return {
    ...settings,
    engineeringTools: {
      ...settings.engineeringTools,
      enabled: true,
      modeling: {
        ...settings.engineeringTools.modeling,
        enabled: true,
        artifactRoot: `${project.projectRoot}/${PROJECT_ENGINEERING_INPUT_ROOT}`
      }
    }
  };
}
