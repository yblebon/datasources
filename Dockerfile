FROM openjdk:11-jre-slim

# Install dependencies
RUN apt-get update && \
    apt-get install -y \
    curl \
    git \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Download and install Digdag
RUN curl -L -o /usr/local/bin/digdag https://dl.digdag.io/digdag-latest && \
    chmod +x /usr/local/bin/digdag && \
    digdag --version

# Create workspace directory
WORKDIR /workspace

# Set environment variables
ENV DIGDAG_HOME=/workspace/.digdag

# Entrypoint
ENTRYPOINT ["digdag"]
CMD ["run"]
