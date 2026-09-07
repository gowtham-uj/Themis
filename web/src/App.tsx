import { NavLink, Route, Routes } from 'react-router-dom'
import Projects from './pages/Projects'
import Project from './pages/Project'
import ProjectSettings from './pages/ProjectSettings'
import Evals from './pages/Evals'
import EvalStore from './pages/EvalStore'
import Queue from './pages/Queue'
import EvalLive from './pages/EvalLive'
import RunDetail from './pages/RunDetail'
import Archives from './pages/Archives'
import ArchiveDetail from './pages/ArchiveDetail'
import Models from './pages/Models'

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Themis</div>
        <nav aria-label="Primary">
          <NavLink to="/projects" end>Projects</NavLink>
          <NavLink to="/eval-store">Eval store</NavLink>
          <NavLink to="/archives">Archives</NavLink>
          <NavLink to="/models">Models</NavLink>
        </nav>
        <div className="build-id" title="Build id of the loaded bundle. Hard-reload if it differs from the deployed one.">
          build {__BUILD_ID__}
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<Project />} />
          <Route path="/projects/:id/settings" element={<ProjectSettings />} />
          <Route path="/projects/:id/evals" element={<Evals />} />
          <Route path="/projects/:id/queue" element={<Queue />} />
          <Route path="/projects/:id/live" element={<EvalLive />} />
          <Route path="/projects/:id/runs/:generationId" element={<EvalLive />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/eval-store" element={<EvalStore />} />
          <Route path="/archives" element={<Archives />} />
          <Route path="/archives/:runId" element={<ArchiveDetail />} />
          <Route path="/models" element={<Models />} />
        </Routes>
      </main>
    </div>
  )
}
