UUID = claude-usage@gnome
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: install uninstall pack schemas

# Compile GSettings schema
schemas:
	glib-compile-schemas schemas/

# Install extension locally
install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r extension.js prefs.js stylesheet.css metadata.json $(INSTALL_DIR)/
	mkdir -p $(INSTALL_DIR)/schemas
	cp schemas/*.xml $(INSTALL_DIR)/schemas/
	glib-compile-schemas $(INSTALL_DIR)/schemas/
	@echo "Installed to $(INSTALL_DIR)"
	@echo "Run: gnome-extensions enable $(UUID)"

# Uninstall extension
uninstall:
	rm -rf $(INSTALL_DIR)
	@echo "Uninstalled $(UUID)"

# Build distributable zip
pack: schemas
	rm -f $(UUID).zip
	zip -r $(UUID).zip extension.js prefs.js stylesheet.css metadata.json schemas/
	@echo "Packed $(UUID).zip"
