return {
  {
    "folke/snacks.nvim",
    keys = {
      { "<leader>fe", false },
      { "<leader>fE", false },
      { "<leader>E", false },
      { "<leader>e", false },
    },
    opts = {
      explorer = { enabled = false },
    },
  },
  {
    "nvim-mini/mini.files",
    lazy = false,
    keys = {
      { "<leader>e", function() require("mini.files").open(vim.api.nvim_buf_get_name(0)) end, desc = "Open mini.files in directory of current file" },
      { "<leader>E", function() require("mini.files").open() end, desc = "Open mini.files" }

    },
    opts = {
      options = {
        use_as_default_explorer = true,
      },
    },
  },
}
