## Local Offline Run Guide

Follow these steps exactly:

1. Press the `win` key on your keyboard.
2. Type `ubuntu` in the search box.
3. Click the Ubuntu app to open the WSL terminal.
4. In the Ubuntu terminal, go to the project folder:

    ```bash
    cd /mnt/c/virtual-try-on-app
    ```

5. Activate the existing Python environment:

    ```bash
    source .venv/bin/activate
    ```

6. Start the web app:

    ```bash
    python webapp/server.py
    ```

7. Wait until the server starts successfully.
8. Open your browser and go to:

    ```text
    http://127.0.0.1:8000
    ```

9. The app should open locally from the already-installed environment.

If the browser does not load the page, make sure the server is still running in the Ubuntu terminal and try again.

## App Functionalities

This app lets you upload:

- a person photo
- a garment photo

Then it generates a virtual try-on result by combining the person and garment using the model pipeline.

For the best results:

- Use a clear person photo with the full body visible and good lighting.
- A garment photo where a person is wearing the item is usually better, because the model can understand the garment shape, fit, and drape more accurately.
- If using a flat-lay garment image, make sure it is clean, well-lit, and clearly shows the clothing item.
- Avoid blurry, heavily shadowed, or low-contrast images.

It includes:

- category selection: tops, bottoms, or one-pieces
- garment photo type selection: model photo or flat-lay photo
- adjustable generation settings
- output preview and downloadable try-on results
- local offline use without needing internet access after setup
