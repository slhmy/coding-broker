import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { Toaster } from "@/components/ui/sonner"
import { AgentsPage } from "@/pages/agents"
import { ProjectPage } from "@/pages/project"
import { ProjectsPage } from "@/pages/projects"
import { SessionPage } from "@/pages/session"

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate replace to="/agents" />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="sessions/:sessionId" element={<SessionPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectSlug" element={<ProjectPage />} />
          <Route path="*" element={<Navigate replace to="/agents" />} />
        </Route>
      </Routes>
      <Toaster />
    </BrowserRouter>
  )
}

export default App
