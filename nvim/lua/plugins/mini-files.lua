return {
  "nvim-mini/mini.files",
  dependencies = { "nvim-telescope/telescope.nvim" },
  version = false,
  opts = {
    windows = {
      preview = false,
      width_preview = 100,
    },
  },
  config = function(_, opts)
    require("mini.files").setup(opts)
    require("plugins.mini-files.mini-extras").setup()
  end,
}
