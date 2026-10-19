from fastapi import FastAPI
app = FastAPI()

@app.get("/users/{user_id}")
def get_user(user_id: int, verbose: bool = False):
    return {"id": user_id}

@app.post("/users")
def create_user(name: str):
    return {"name": name}
