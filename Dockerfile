FROM debian:bookworm-slim

# Install Python3, wget, curl and dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Oracle JDK 25.0.2 (matching your exact version)
RUN wget -O /tmp/jdk-25_linux-x64_bin.deb \
        "https://download.oracle.com/java/25/latest/jdk-25_linux-x64_bin.deb" \
    && apt-get update \
    && dpkg -i /tmp/jdk-25_linux-x64_bin.deb \
    && rm /tmp/jdk-25_linux-x64_bin.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Fix Java alternatives path (based on your install output)
RUN update-alternatives --install /usr/bin/java java /usr/lib/jvm/jdk-25.0.2-oracle-x64/bin/java 1 \
    && update-alternatives --set java /usr/lib/jvm/jdk-25.0.2-oracle-x64/bin/java

# Install Digdag (fixing AggressiveOpts issue)
RUN curl -o /usr/local/bin/digdag --create-dirs -L "https://dl.digdag.io/digdag-latest" \
    && chmod +x /usr/local/bin/digdag \
    && echo 'export DIGDAG_JAVA_OPTS="-Xmx512m"' >> /etc/environment

# Verify installations
RUN java --version && python3 --version && digdag --version

# Default command
CMD ["/bin/bash"]
