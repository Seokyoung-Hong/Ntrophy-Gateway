$py = ".\.venv\Scripts\python.exe"
Start-Process $py "-m uvicorn app.mock_provider.main:app --port 9000" -NoNewWindow
& $py -m uvicorn app.main:app --port 8000
