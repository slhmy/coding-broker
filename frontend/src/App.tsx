import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { Toaster } from "@/components/ui/sonner"
import { SessionBranchPage } from "@/pages/session-branch"
import { SessionPage } from "@/pages/session"
import { WorkspacePage } from "@/pages/workspace"

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate replace to="/workspace" />} />
          <Route path="workspace" element={<WorkspacePage />} />
          <Route path="sessions/:sessionId" element={<SessionPage />} />
          <Route
            path="sessions/:sessionId/branch"
            element={<SessionBranchPage />}
          />
          <Route path="*" element={<Navigate replace to="/workspace" />} />
        </Route>
      </Routes>
      <Toaster />
    </BrowserRouter>
  )
}

export default App
