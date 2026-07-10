import { Navigate, createBrowserRouter } from "react-router-dom";
import { AppShell } from "./AppShell.js";
import { RouteErrorBoundary } from "./RouteErrorBoundary.js";

const projectsPage = () => import("../features/projects/public.js").then((module) => ({ Component: module.ProjectsPage }));
const newProjectPage = () => import("../features/projects/public.js").then((module) => ({ Component: module.NewProjectPage }));
const chatPage = () => import("../features/chat/public.js").then((module) => ({ Component: module.ChatPage }));
const newChatPage = () => import("../features/chat/public.js").then((module) => ({ Component: () => <module.ChatPage newSession /> }));
const projectBriefPage = () => import("../features/settings/public.js").then((module) => ({ Component: module.ProjectBriefPage }));
const runPolicyPage = () => import("../features/settings/public.js").then((module) => ({ Component: module.RunPolicyPage }));
const codexSettingsPage = () => import("../features/settings/public.js").then((module) => ({ Component: module.CodexSettingsPage }));
const connectionsPage = () => import("../features/settings/public.js").then((module) => ({ Component: module.ConnectionsPage }));
const toolsPage = () => import("../features/settings/public.js").then((module) => ({ Component: module.ToolsPage }));
const appearancePage = () => import("../features/settings/public.js").then((module) => ({ Component: module.AppearancePage }));

export const appRouter = createBrowserRouter([
  {
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { index: true, element: <Navigate to="/projects" replace /> },
      { path: "projects", lazy: projectsPage },
      { path: "projects/new", lazy: newProjectPage },
      { path: "projects/:projectId/chats/new", lazy: newChatPage },
      { path: "projects/:projectId/chats/:sessionId", lazy: chatPage },
      { path: "projects/:projectId/settings/brief", lazy: projectBriefPage },
      { path: "projects/:projectId/settings/run-policy", lazy: runPolicyPage },
      { path: "settings/codex", lazy: codexSettingsPage },
      { path: "settings/connections", lazy: connectionsPage },
      { path: "settings/tools", lazy: toolsPage },
      { path: "settings/appearance", lazy: appearancePage },
      { path: "*", element: <Navigate to="/projects" replace /> }
    ]
  }
]);
