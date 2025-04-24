### to run locally and call prod db
To make your locally running server communicate with production Firestore data:
Use Google application default credentials (simplest approach)
   gcloud auth application-default login

This will open a browser window to authenticate you. After login, credentials will be saved locally.
Restart your functions emulator without the Firestore emulator
   firebase emulators:start --only functions