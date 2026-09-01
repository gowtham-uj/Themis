import { NavLink, Route, Routes } from 'react-router-dom'
import Projects from './pages/Projects'
import Project from './pages/Project'
import Adapters from './pages/Adapters'
import Evals from './pages/Evals'
import Queue from './pages/Queue'
import EvalLive from './pages/EvalLive'
import RunDetail from './pages/RunDetail'
import Archives from './pages/Archives'

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">agenteval</div>
        <nav aria-label="Primary">
          <NavLink to="/projects" end>Projects</NavLink>
          <NavLink to="/archives">Archives</NavLink>
          <span className="nav-disabled" aria-disabled="true" title="Phase 1 panel is disabled">Phase 1</span>
          <span className="nav-disabled" aria-disabled="true" title="Phase 2 panel is disabled">Phase 2</span>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Projects />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<Project />} />
          <Route path="/projects/:id/adapters" element={<Adapters />} />
          <Route path="/projects/:id/evals" element={<Evals />} />
          <Route path="/projects/:id/queue" element={<Queue />} />
          <Route path="/projects/:id/live" element={<EvalLive />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/archives" element={<Archives />} />
          <Route path="/phase1" element={<Projects />} />
          <Route path="/phase2" element={<Projects />} />
        </Routes>
      </main>
    </div>
  )
}
