return {
  "3rd/image.nvim",
  build = false,
  opts = {
    backend = "kitty",
    processor = "magick_cli",
    kitty_method = "normal",

    max_width_window_percentage = 100,
    max_height_window_percentage = 90,

    integrations = {
      markdown = {
        enabled = true,
        clear_in_insert_mode = false,
        download_remote_images = true,
        only_render_image_at_cursor = false,
        filetypes = { "markdown", "vimwiki" },
      },
    },

    hijack_file_patterns = {
      "*.png",
      "*.jpg",
      "*.jpeg",
      "*.gif",
      "*.webp",
      "*.avif",
      "*.bmp",
      "*.svg",
      "*.pdf",
    },
  }
}
