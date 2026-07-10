import { queryOptions } from "@tanstack/react-query";
import { jobApi } from "./jobApi.js";
import { projectApi } from "./projectApi.js";
import { settingsApi } from "./settingsApi.js";
import { snapshotApi } from "./snapshotApi.js";
import { shellQueryKeys } from "./queryKeys.js";

const defaults = { gcTime: 300_000, refetchOnReconnect: true, refetchOnWindowFocus: false } as const;

export const projectsListQueryOptions = () =>
  queryOptions({ ...defaults, queryKey: shellQueryKeys.projects.all(), queryFn: projectApi.list, staleTime: Infinity });
export const projectQueryOptions = (projectId: string) =>
  queryOptions({
    ...defaults,
    enabled: Boolean(projectId),
    queryKey: shellQueryKeys.projects.detail(projectId),
    queryFn: () => projectApi.get(projectId),
    staleTime: Infinity
  });
export const projectSnapshotQueryOptions = (projectId: string) =>
  queryOptions({
    ...defaults,
    enabled: Boolean(projectId),
    queryKey: shellQueryKeys.projects.snapshot(projectId),
    queryFn: () => snapshotApi.get(projectId),
    staleTime: Infinity
  });
export const projectJobsQueryOptions = (projectId: string) =>
  queryOptions({
    ...defaults,
    enabled: Boolean(projectId),
    queryKey: shellQueryKeys.projects.jobs(projectId),
    queryFn: () => jobApi.list(projectId),
    staleTime: Infinity
  });
export const settingsQueryOptions = () => queryOptions({ ...defaults, queryKey: shellQueryKeys.settings(), queryFn: settingsApi.get, staleTime: Infinity });
export const llmStatusQueryOptions = () =>
  queryOptions({ ...defaults, queryKey: shellQueryKeys.llmStatus(), queryFn: settingsApi.llmStatus, staleTime: 30_000 });
export const toolsDiagnosticsQueryOptions = () =>
  queryOptions({ ...defaults, queryKey: shellQueryKeys.toolsDiagnostics(), queryFn: settingsApi.tools, staleTime: 30_000 });
