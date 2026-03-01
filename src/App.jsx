import AdminPage from './AdminPage';
import StudentExamApp from './StudentExamApp';
import './App.css';

function App() {
  const isAdminRoute = window.location.pathname.toLowerCase().startsWith('/admin');
  return isAdminRoute ? <AdminPage /> : <StudentExamApp />;
}

export default App;
