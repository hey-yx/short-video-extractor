import { createApp } from "./app";

export const startServer = () => {
  const PORT = Bun.env.SERVER_PORT || 7777;

  createApp().listen(PORT, () =>
    console.log(`Server is running on http://localhost:${PORT}`),
  );
};
