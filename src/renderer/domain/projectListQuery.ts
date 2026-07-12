import { queryOptions } from "@tanstack/react-query";
import { listProjects } from "./projectListApi.js";
import { shellQueryKeys } from "./queryKeys.js";

const PROJECT_LIST_GC_TIME_MS = 300_000;

export const projectsListQueryOptions = () =>
  queryOptions({
    gcTime: PROJECT_LIST_GC_TIME_MS,
    queryKey: shellQueryKeys.projects.all(),
    queryFn: listProjects,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
    staleTime: Infinity
  });
