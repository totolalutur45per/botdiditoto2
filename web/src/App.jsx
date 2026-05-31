import { useState } from 'react';
import PlayerTable from './components/PlayerTable';
import ScrimBoard from './components/ScrimBoard';
import './App.css';

const TABS = [
  { id: 'players', label: 'Players' },
  { id: 'scrims', label: 'Scrims' },
];

function App() {
  const [activeTab, setActiveTab] = useState('players');

  return (
    <div className="app">
      <header className="app-header">
        <h1>Bot Scrim Manager</h1>
        <nav className="tab-nav">
          {TABS.map(tab => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {activeTab === 'players' && <PlayerTable />}
        {activeTab === 'scrims' && <ScrimBoard />}
      </main>
    </div>
  );
}

export default App;
